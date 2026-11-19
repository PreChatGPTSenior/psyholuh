import asyncio
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, FastAPI, File, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import config
from .budget import budget_view, chat_costs, parse_limit, update_budget
from .db import (
    MESSAGE_FIELDS,
    APIError,
    activate,
    active_chat,
    expire_generations,
    get_chat,
    initialize,
    new_id,
    read,
    require_active,
    utc_now,
    write,
)
from .demo import seed
from .generation import Submission, claim_submission, stream
from .jobs import (
    SELECT_AUDIO,
    audio_path,
    cleanup_path,
    create_audio,
    discard_audio,
    get_audio_job,
    public_audio,
    retry_audio,
)
from .memory import memory_view
from .providers import run_cost_reconciliation

AUDIO_SUFFIXES = {"wav", "mp3", "m4a", "mp4", "ogg", "webm"}
AUDIO_TYPES = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/vnd.wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "video/ogg": "ogg",
    "application/ogg": "ogg",
    "audio/webm": "webm",
    "video/webm": "webm",
}


class NewChat(BaseModel):
    model_id: str = Field(min_length=1)
    title: str = Field(default="Новая беседа", min_length=1, max_length=120)


class BudgetSettings(BaseModel):
    limit_usd: str = Field(strict=True, max_length=17)


@asynccontextmanager
async def startup(_: FastAPI):
    initialize()
    seed()
    task = None
    if not config.DEMO and config.OPENROUTER_API_KEY:
        task = asyncio.create_task(run_cost_reconciliation())
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(
    title="psyholuh", lifespan=startup, docs_url=None, redoc_url=None, openapi_url=None
)
api = APIRouter(prefix="/api")


@app.exception_handler(APIError)
def api_error(_: Request, exc: APIError):
    return JSONResponse(status_code=exc.status, content=exc.detail)


@app.exception_handler(RequestValidationError)
def bad_input(_: Request, __: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "code": "invalid_request",
            "message": "Проверьте данные запроса.",
            "retryable": False,
        },
    )


@api.get("/health")
def health():
    return {"status": "ok", "demo": config.DEMO}


@api.get("/models")
def models():
    return {"models": config.MODELS}


@api.get("/chats")
def list_chats():
    with read() as db:
        chats = db.execute(
            "SELECT * FROM chats ORDER BY updated_at DESC, id"
        ).fetchall()
        return {
            "active_chat_id": active_chat(db),
            "chats": [dict(chat) for chat in chats],
        }


@api.post("/chats", status_code=201)
def create_chat(body: NewChat):
    if body.model_id not in config.WINDOWS:
        raise APIError(422, "unknown_model", "Выберите доступную модель.")
    chat_id = new_id()
    with write() as db:
        timestamp = utc_now()
        db.execute(
            "INSERT INTO chats (id, model_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (chat_id, body.model_id, body.title, timestamp, timestamp),
        )
        return activate(db, chat_id)


@api.post("/chats/{chat_id}/activate")
def activate_chat(chat_id: str):
    with write() as db:
        return activate(db, chat_id)


@api.get("/chats/{chat_id}/messages")
def list_messages(
    chat_id: str,
    before_seq: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    with write() as db:
        get_chat(db, chat_id)
        expire_generations(db, chat_id)
        upper_bound = (
            "" if before_seq is None or before_seq > 2**63 - 1 else "AND seq<?"
        )
        parameters = (
            (chat_id, before_seq, limit + 1) if upper_bound else (chat_id, limit + 1)
        )
        rows = db.execute(
            f"""SELECT {MESSAGE_FIELDS} FROM messages WHERE chat_id=? {upper_bound}
                ORDER BY seq DESC LIMIT ?""",
            parameters,
        ).fetchall()
        return {
            "messages": [dict(row) for row in reversed(rows[:limit])],
            "next_before_seq": rows[limit - 1]["seq"] if len(rows) > limit else None,
        }


@api.post("/chats/{chat_id}/messages")
def send_message(chat_id: str, body: Submission):
    attempt = claim_submission(chat_id, body)
    return StreamingResponse(
        stream(attempt),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@api.get("/chats/{chat_id}/audio")
def list_audio(chat_id: str):
    with read() as db:
        get_chat(db, chat_id)
        rows = db.execute(
            f"{SELECT_AUDIO} AND j.chat_id=? ORDER BY j.created_at DESC, j.id",
            (chat_id,),
        )
        return {"jobs": [public_audio(row) for row in rows]}


def audio_extension(file: UploadFile) -> str:
    suffix = Path(file.filename or "").suffix.lower().lstrip(".")
    media_type = (file.content_type or "").split(";", maxsplit=1)[0].strip().lower()
    if media_type in ("", "application/octet-stream") and suffix in AUDIO_SUFFIXES:
        return suffix
    if media_type in AUDIO_TYPES:
        return suffix if suffix in AUDIO_SUFFIXES else AUDIO_TYPES[media_type]
    raise APIError(
        415, "unsupported_audio", "Поддерживаются WAV, MP3, M4A/MP4, Ogg и WebM."
    )


@api.post("/chats/{chat_id}/audio", status_code=202)
def upload_audio(chat_id: str, file: Annotated[UploadFile, File()]):
    with read() as db:
        get_chat(db, chat_id)
        require_active(db, chat_id)
    extension = audio_extension(file)
    audio_id = new_id()
    staging = config.AUDIO_DIR / f"{audio_id}.upload"
    original = audio_path(audio_id, extension)
    size = 0
    try:
        with staging.open("xb") as target:
            os.chmod(staging, 0o600)
            while chunk := file.file.read(256 * 1024):
                size += len(chunk)
                if size > config.DRAFT_LIMIT:
                    raise APIError(
                        413, "audio_too_large", "Размер записи превышает 25 МиБ."
                    )
                target.write(chunk)
            if not size:
                raise APIError(422, "empty_audio", "В записи нет аудиоданных.")
            target.flush()
            os.fsync(target.fileno())
        with write() as db:
            require_active(db, chat_id)
            # Publish the file before its outbox row is visible to the worker.
            staging.replace(original)
            result = create_audio(db, chat_id, audio_id, extension)
    except BaseException:
        cleanup_path(original)
        raise
    finally:
        cleanup_path(staging)
    return result


@api.delete("/chats/{chat_id}/audio/{audio_id}", status_code=204)
def delete_audio(chat_id: str, audio_id: str):
    with write() as db:
        get_chat(db, chat_id)
        original = discard_audio(db, chat_id, audio_id)
    cleanup_path(original)
    return Response(status_code=204)


@api.get("/jobs/{job_id}")
def get_job(job_id: str):
    with read() as db:
        return public_audio(get_audio_job(db, job_id))


@api.post("/jobs/{job_id}/retry", status_code=202)
def retry_job(job_id: str):
    with write() as db:
        return retry_audio(db, job_id)


@api.get("/chats/{chat_id}/memory")
def get_memory(chat_id: str):
    with read() as db:
        get_chat(db, chat_id)
        return memory_view(db, chat_id)


@api.get("/settings/budget")
def get_budget():
    with read() as db:
        return budget_view(db)


@api.put("/settings/budget")
def set_budget(body: BudgetSettings):
    limit = parse_limit(body.limit_usd)
    with write() as db:
        return update_budget(db, limit)


@api.get("/chats/{chat_id}/costs")
def get_costs(chat_id: str):
    with read() as db:
        get_chat(db, chat_id)
        return chat_costs(db, chat_id)


app.include_router(api)
