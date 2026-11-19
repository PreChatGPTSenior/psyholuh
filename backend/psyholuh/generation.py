import asyncio
import json
import logging
import sqlite3
import time
from collections.abc import AsyncIterator
from contextlib import suppress
from dataclasses import dataclass
from typing import Literal

import httpx
from pydantic import BaseModel, Field, model_validator

from . import config
from .budget import BUDGET_CODES, ChargeScope
from .db import (
    MESSAGE_FIELDS,
    APIError,
    encode,
    expire_generations,
    get_chat,
    get_message,
    insert_message,
    new_id,
    read,
    require_active,
    utc_now,
    write,
)
from .jobs import cleanup_path, discard_audio
from .memory import (
    MODE_INSTRUCTIONS,
    SYSTEM,
    clip_bytes,
    cost,
    infer_note,
    invalidated_by_reply,
    memory_job,
    schedule_background,
    search,
    summary_at,
    summary_cap,
)
from .providers import ProviderError, compress, reply

LOGGER = logging.getLogger(__name__)


class Submission(BaseModel):
    text: str = Field(min_length=1)
    request_id: str = Field(min_length=1, max_length=128)
    mode: Literal["listen", "analyze"] = "listen"
    audio_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def require_audio_id_string(self):
        if "audio_id" in self.model_fields_set and self.audio_id is None:
            raise ValueError("audio_id must be a nonempty string when provided")
        return self


@dataclass
class Attempt:
    user: dict
    assistant: dict
    key: str | None = None


@dataclass
class Window:
    messages: list[dict[str, str]]
    evidence: dict


@dataclass
class Checkpoint:
    job_id: str


class LeaseLost(Exception):
    pass


def claim_submission(chat_id: str, submission: Submission) -> Attempt:
    original_audio = None
    with write() as db:
        chat = get_chat(db, chat_id)
        expire_generations(db, chat_id)
        existing = db.execute(
            f"SELECT {MESSAGE_FIELDS} FROM messages WHERE chat_id=? AND request_id=? ORDER BY seq",
            (chat_id, submission.request_id),
        ).fetchall()
        if existing:
            user, assistant = map(dict, existing)
            if tuple(user[key] for key in ("text", "mode", "audio_id")) != (
                submission.text,
                submission.mode,
                submission.audio_id,
            ):
                raise APIError(
                    409,
                    "request_conflict",
                    "Этот идентификатор уже использован с другими данными.",
                )
            if assistant["status"] in ("complete", "streaming"):
                return Attempt(user, assistant)
        require_active(db, chat_id)
        if db.execute(
            "SELECT 1 FROM messages WHERE chat_id=? AND status='streaming'", (chat_id,)
        ).fetchone():
            raise APIError(409, "generation_active", "Дождитесь текущего ответа.", True)
        key = new_id()
        if existing:
            db.execute(
                """UPDATE messages SET status='streaming', text='', attempt_id=?, lease_until=?
                   WHERE id=?""",
                (key, time.time() + config.LEASE_SECONDS, assistant["id"]),
            )
            assistant = dict(get_message(db, assistant["id"]))
        else:
            if submission.audio_id:
                audio = db.execute(
                    """SELECT 1 FROM audio a JOIN jobs j ON j.audio_id=a.id
                       WHERE a.id=? AND a.chat_id=? AND a.discarded=0 AND j.status='succeeded'""",
                    (submission.audio_id, chat_id),
                ).fetchone()
                if audio is None:
                    raise APIError(
                        409,
                        "audio_unavailable",
                        "Этот аудиочерновик недоступен для отправки.",
                    )
                original_audio = discard_audio(db, chat_id, submission.audio_id)
            seq = db.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE chat_id=?",
                (chat_id,),
            ).fetchone()[0]
            user = insert_message(
                db,
                chat_id=chat_id,
                seq=seq,
                role="user",
                text=submission.text,
                request_id=submission.request_id,
                mode=submission.mode,
                model_id=None,
                audio_id=submission.audio_id,
            )
            infer_note(db, user)
            assistant = insert_message(
                db,
                chat_id=chat_id,
                seq=seq + 1,
                role="assistant",
                text="",
                request_id=submission.request_id,
                mode=submission.mode,
                model_id=chat["model_id"],
                status="streaming",
                attempt_id=key,
            )
            user, assistant = dict(user), dict(assistant)
        if not existing:
            db.execute(
                "UPDATE chats SET mode=?, updated_at=? WHERE id=?",
                (submission.mode, utc_now(), chat_id),
            )
        schedule_background(db, chat_id, user["seq"] - 1)
    if original_audio:
        cleanup_path(original_audio)
    return Attempt(user, assistant, key)


def append_fragment(attempt: Attempt, text: str) -> None:
    with write() as db:
        changed = db.execute(
            """UPDATE messages SET text=text || ?
               WHERE id=? AND status='streaming' AND attempt_id=? AND lease_until>?""",
            (text, attempt.assistant["id"], attempt.key, time.time()),
        ).rowcount
        if not changed:
            raise LeaseLost()


def complete_reply(attempt: Attempt, evidence: dict, actual_model: str) -> dict:
    with write() as db:
        changed = db.execute(
            """UPDATE messages SET status='complete', completed_at=?, model_id=?, evidence=?,
                 reply_charge_id=(SELECT id FROM openrouter_charges
                                  WHERE category='reply' AND assistant_id=messages.id AND openrouter_charges.attempt_id=messages.attempt_id
                                  LIMIT 1),
                 attempt_id=NULL, lease_until=NULL
               WHERE id=? AND status='streaming' AND attempt_id=? AND lease_until>?""",
            (
                utc_now(),
                actual_model,
                encode(evidence),
                attempt.assistant["id"],
                attempt.key,
                time.time(),
            ),
        ).rowcount
        if not changed:
            raise LeaseLost()
        assistant = get_message(db, attempt.assistant["id"])
        infer_note(db, assistant)
        invalidated_by_reply(db, assistant["chat_id"], assistant["seq"])
        schedule_background(db, assistant["chat_id"], 2**63 - 1)
        db.execute(
            "UPDATE chats SET updated_at=? WHERE id=?",
            (utc_now(), assistant["chat_id"]),
        )
        return dict(assistant)


def interrupt(attempt: Attempt) -> None:
    with write() as db:
        db.execute(
            """UPDATE messages SET status='interrupted', attempt_id=NULL, lease_until=NULL
               WHERE id=? AND status='streaming' AND attempt_id=?""",
            (attempt.assistant["id"], attempt.key),
        )


def renew(attempt: Attempt) -> bool:
    with write() as db:
        now = time.time()
        return bool(
            db.execute(
                """UPDATE messages SET lease_until=?
               WHERE id=? AND status='streaming' AND attempt_id=? AND lease_until>?""",
                (now + config.LEASE_SECONDS, attempt.assistant["id"], attempt.key, now),
            ).rowcount
        )


def input_budget(attempt: Attempt) -> int:
    # A model removed from the menu remains frozen on its existing chat.
    return (
        config.WINDOWS.get(attempt.assistant["model_id"], min(config.WINDOWS.values()))
        - config.RESPONSE_TOKENS
    )


def base_instructions(attempt: Attempt) -> str:
    return f"{SYSTEM}\nРежим: {MODE_INSTRUCTIONS[attempt.user['mode']]}"


def build_window(attempt: Attempt, user_text: str) -> Window | Checkpoint:
    chat_id, user_seq = attempt.user["chat_id"], attempt.user["seq"]
    instructions = base_instructions(attempt)
    budget = input_budget(attempt)
    with read() as db:
        summary = summary_at(db, chat_id, user_seq - 1)
        covered = summary["covered_through_seq"]
        system = instructions
        if summary["text"]:
            system += f"\n\nСводка до реплики №{covered}:\n{clip_bytes(summary['text'], summary_cap())}"
        remaining = budget - cost(system) - cost(user_text)
        # Read most recent uncovered history first, but never skip a row. If
        # the full uncovered suffix does not fit, advance a durable checkpoint.
        allowance = max(0, min(3000, remaining // 4)) if covered else 0
        tail = []
        overflow = None
        for row in db.execute(
            """SELECT id, seq, role, text FROM messages
               WHERE chat_id=? AND seq>? AND seq<? AND status='complete' ORDER BY seq DESC""",
            (chat_id, covered, user_seq),
        ):
            row_cost = cost(row["text"])
            if row_cost > remaining - allowance:
                overflow = row["seq"]
                break
            remaining -= row_cost
            tail.append(row)
        if overflow is None:
            tail.reverse()
            retrieved = []
            for quote, role in search(
                db, chat_id, attempt.user["text"], tail, covered, user_seq
            ):
                label = (
                    "исторический, заменён"
                    if quote["historical"]
                    else "актуальный источник"
                )
                block = f"\n[№{quote['seq']}; {role}; {label}] {quote['excerpt']}"
                block_cost = len(block.encode("utf-8"))
                if block_cost <= remaining:
                    system += block
                    remaining -= block_cost
                    retrieved.append(quote)
            messages = [
                {"role": "system", "content": system},
                *({"role": item["role"], "content": item["text"]} for item in tail),
                {"role": "user", "content": user_text},
            ]
            evidence = {
                "message_id": attempt.assistant["id"],
                "summary_version": summary["version"],
                "covered_through_seq": covered,
                "tail_seqs": [item["seq"] for item in tail],
                "retrieved": retrieved,
            }
            return Window(messages, evidence)
    with write() as db:
        # A checkpoint may finish while switching from read to write.
        if summary_at(db, chat_id, user_seq - 1)["version"] != summary["version"]:
            return Checkpoint("")
        target = min(overflow, covered + 48)
        return Checkpoint(memory_job(db, chat_id, summary, target))


def job_status(job_id: str) -> tuple[str, dict | None]:
    with read() as db:
        status, error = db.execute(
            "SELECT status, error FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        return status, json.loads(error) if error else None


async def prepare(attempt: Attempt, user_text: str) -> Window:
    deadline = time.monotonic() + 145
    while True:
        action = await asyncio.to_thread(build_window, attempt, user_text)
        if isinstance(action, Window):
            return action
        if not action.job_id:
            continue
        while True:
            status, error = await asyncio.to_thread(job_status, action.job_id)
            if status == "succeeded":
                break
            if status == "failed" and error and error["code"] in BUDGET_CODES:
                raise APIError(503, error["code"], error["message"], error["retryable"])
            if status == "failed" or time.monotonic() >= deadline:
                raise APIError(
                    503,
                    "summary_unavailable",
                    "Не удалось подготовить контекст. Повторите запрос.",
                    True,
                )
            await asyncio.sleep(0.4)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {encode(data)}\n\n"


def done(attempt: Attempt) -> str:
    return sse("done", {"user": attempt.user, "assistant": attempt.assistant})


async def produce(attempt: Attempt, output: asyncio.Queue) -> None:
    async def status(phase: str) -> None:
        await output.put(
            sse("status", {"phase": phase, "request_id": attempt.user["request_id"]})
        )

    completed = False
    try:
        scope = ChargeScope(
            attempt.user["chat_id"], attempt.key, assistant_id=attempt.assistant["id"]
        )
        await status("preparing_context")
        text = attempt.user["text"]
        long_threshold = (
            input_budget(attempt)
            - cost(base_instructions(attempt))
            - summary_cap()
            - 400
        )
        if cost(text) > long_threshold:
            await status("processing_long_message")
            seq = attempt.user["seq"]
            shortened = await compress("", [(f"№{seq} (user): ", text)], scope)
            text = (
                f"Сжатое содержание длинной реплики пользователя №{seq}:\n{shortened}"
            )
        window = await prepare(attempt, text)
        await status("generating")
        has_output = False
        selected_model = attempt.assistant["model_id"]
        actual_model = selected_model
        async for part in reply(
            selected_model, window.messages, attempt.user["mode"], scope
        ):
            if part.model_id:
                actual_model = part.model_id
            if part.text:
                append_fragment(attempt, part.text)
                has_output = True
                await output.put(sse("delta", {"text": part.text}))
        if not has_output:
            raise ProviderError("Модель не вернула текст ответа.")
        attempt.assistant = complete_reply(attempt, window.evidence, actual_model)
        completed = True
        await output.put(done(attempt))
    except APIError as exc:
        await output.put(sse("error", exc.detail))
    except (ProviderError, httpx.HTTPError, ValueError) as exc:
        LOGGER.warning("Provider operation failed (%s).", type(exc).__name__)
        message = (
            str(exc)
            if isinstance(exc, ProviderError)
            else "Не удалось получить ответ модели. Попробуйте снова."
        )
        await output.put(
            sse(
                "error",
                {"code": "provider_error", "message": message, "retryable": True},
            )
        )
    except LeaseLost:
        await output.put(
            sse(
                "error",
                {
                    "code": "attempt_expired",
                    "message": "Попытка устарела. Повторите запрос.",
                    "retryable": True,
                },
            )
        )
    except Exception as exc:  # noqa: BLE001 - translate unexpected stream failures into a terminal event
        LOGGER.warning("Reply attempt failed (%s).", type(exc).__name__)
        await output.put(
            sse(
                "error",
                {
                    "code": "generation_failed",
                    "message": "Не удалось завершить ответ. Повторите запрос.",
                    "retryable": True,
                },
            )
        )
    finally:
        if not completed:
            interrupt(attempt)


async def keep_lease(attempt: Attempt) -> None:
    while True:
        await asyncio.sleep(20)
        if not await asyncio.to_thread(renew, attempt):
            return


async def stream(attempt: Attempt) -> AsyncIterator[str]:
    if attempt.key is None:
        if attempt.assistant["status"] == "streaming":
            yield sse(
                "status",
                {"phase": "already_running", "request_id": attempt.user["request_id"]},
            )
        else:
            yield done(attempt)
        return
    output: asyncio.Queue = asyncio.Queue()
    worker = asyncio.create_task(produce(attempt, output))
    heartbeat = asyncio.create_task(keep_lease(attempt))

    def finished(_: asyncio.Task) -> None:
        output.put_nowait(None)

    worker.add_done_callback(finished)
    try:
        while True:
            try:
                frame = await asyncio.wait_for(output.get(), timeout=12)
            except TimeoutError:
                yield ": keepalive\n\n"
                continue
            if frame is None:
                break
            yield frame
    finally:
        worker.cancel()
        heartbeat.cancel()
        for task in (worker, heartbeat):
            with suppress(asyncio.CancelledError, sqlite3.Error):
                await task
