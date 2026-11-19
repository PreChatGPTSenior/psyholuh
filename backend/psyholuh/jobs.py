import argparse
import asyncio
import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

from redis import Redis
from redis.exceptions import RedisError
from rq import Queue, Worker
from rq.exceptions import NoSuchJobError
from rq.job import Job

from . import config
from .budget import BudgetError, ChargeScope
from .db import APIError, encode, initialize, new_id, read, utc_now, write
from .memory import history_rows, summary_at
from .providers import compress

LOGGER = logging.getLogger(__name__)
JOB_TIMEOUTS = {"audio": 900, "memory": 300}
JOB_LEASE = 35
PRICING_RETRY_COOLDOWN = 30
TRANSCRIPTION_ERROR = {
    "code": "transcription_failed",
    "message": "Не удалось расшифровать аудио. Попробуйте снова.",
    "retryable": True,
}
MEMORY_ERROR = {
    "code": "summary_failed",
    "message": "Не удалось подготовить сводку. Попробуйте снова.",
    "retryable": True,
}
SELECT_AUDIO = """
    SELECT j.id AS job_id, j.chat_id, j.audio_id, j.status, j.error, a.extension, a.transcript, j.created_at
    FROM jobs j JOIN audio a ON a.id=j.audio_id
    WHERE j.kind='audio' AND a.discarded=0
"""


def queue_name(kind: str) -> str:
    return f"{config.REDIS_NAMESPACE}-{kind}"


def redis_connection() -> Redis:
    return Redis.from_url(config.REDIS_URL, socket_connect_timeout=2, socket_timeout=20)


def audio_path(audio_id: str, extension: str) -> Path:
    return config.AUDIO_DIR / f"{audio_id}.{extension}"


def public_audio(row: sqlite3.Row) -> dict:
    result = dict(row)
    del result["extension"]
    result["error"] = json.loads(result["error"]) if result["error"] else None
    return result


def get_audio_job(db: sqlite3.Connection, job_id: str) -> sqlite3.Row:
    found = db.execute(f"{SELECT_AUDIO} AND j.id=?", (job_id,)).fetchone()
    if found is None:
        raise APIError(404, "job_not_found", "Аудиозадание не найдено.")
    return found


def retry_audio(db: sqlite3.Connection, job_id: str) -> dict:
    result = get_audio_job(db, job_id)
    if result["status"] != "failed" or not json.loads(result["error"])["retryable"]:
        raise APIError(409, "job_not_retryable", "Это задание сейчас нельзя повторить.")
    db.execute(
        """UPDATE jobs SET status='queued', attempts=0, error=NULL, next_dispatch=0,
             delivery_id=NULL, attempt_id=NULL, lease_until=NULL WHERE id=?""",
        (job_id,),
    )
    return public_audio(get_audio_job(db, job_id))


def cleanup_path(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        LOGGER.warning("Could not remove audio; the reconciler will retry.")


def discard_audio(db: sqlite3.Connection, chat_id: str, audio_id: str) -> Path:
    row = db.execute(
        "SELECT extension FROM audio WHERE chat_id=? AND id=? AND discarded=0",
        (chat_id, audio_id),
    ).fetchone()
    if row is None:
        raise APIError(404, "audio_not_found", "Аудиочерновик не найден.")
    db.execute("UPDATE audio SET discarded=1, transcript=NULL WHERE id=?", (audio_id,))
    db.execute(
        """UPDATE jobs SET status='failed', attempt_id=NULL, lease_until=NULL, error=?
           WHERE audio_id=? AND status IN ('queued','running')""",
        (
            encode(
                {
                    "code": "audio_discarded",
                    "message": "Запись удалена.",
                    "retryable": False,
                }
            ),
            audio_id,
        ),
    )
    return audio_path(audio_id, row["extension"])


def create_audio(
    db: sqlite3.Connection, chat_id: str, audio_id: str, extension: str
) -> dict:
    created = utc_now()
    job_id = new_id()
    db.execute(
        "INSERT INTO audio (id, chat_id, extension, created_at) VALUES (?, ?, ?, ?)",
        (audio_id, chat_id, extension, created),
    )
    db.execute(
        """INSERT INTO jobs (id, chat_id, kind, audio_id, status, created_at)
           VALUES (?, ?, 'audio', ?, 'queued', ?)""",
        (job_id, chat_id, audio_id, created),
    )
    return public_audio(get_audio_job(db, job_id))


def failure(db: sqlite3.Connection, job: sqlite3.Row) -> None:
    error = TRANSCRIPTION_ERROR if job["kind"] == "audio" else MEMORY_ERROR
    terminal = job["attempts"] >= config.MAX_JOB_ATTEMPTS
    db.execute(
        """UPDATE jobs SET status=?, attempt_id=NULL, lease_until=NULL, delivery_id=NULL,
                  next_dispatch=?, error=? WHERE id=?""",
        (
            "failed" if terminal else "queued",
            time.time() + 2 ** job["attempts"],
            encode(error) if terminal else None,
            job["id"],
        ),
    )


def claim(job_id: str, delivery_id: str):
    with write() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if (
            row is None
            or row["status"] != "queued"
            or row["delivery_id"] != delivery_id
        ):
            return None
        token = new_id()
        db.execute(
            """UPDATE jobs SET status='running', attempts=attempts+1,
                      attempt_id=?, lease_until=? WHERE id=?""",
            (token, time.time() + JOB_LEASE, job_id),
        )
        return db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()


def still_owns(db: sqlite3.Connection, claimed: sqlite3.Row):
    return db.execute(
        """SELECT * FROM jobs WHERE id=? AND status='running' AND attempt_id=? AND lease_until>?""",
        (claimed["id"], claimed["attempt_id"], time.time()),
    ).fetchone()


def complete(db: sqlite3.Connection, claimed: sqlite3.Row) -> None:
    db.execute(
        """UPDATE jobs SET status='succeeded', error=NULL, attempt_id=NULL, lease_until=NULL
           WHERE id=?""",
        (claimed["id"],),
    )


def transcribe(job: sqlite3.Row) -> None:
    with read() as db:
        audio = db.execute(
            "SELECT * FROM audio WHERE id=? AND discarded=0", (job["audio_id"],)
        ).fetchone()
    if audio is None:
        return
    path = audio_path(audio["id"], audio["extension"])
    if not path.is_file():
        raise OSError("The original audio is missing.")
    if config.DEMO:
        transcript = "Мне хочется спокойно обсудить то, что произошло сегодня."
    else:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            config.WHISPER_MODEL,
            device=config.WHISPER_DEVICE,
            compute_type=config.WHISPER_COMPUTE_TYPE,
            download_root=config.WHISPER_CACHE,
        )
        segments, _ = model.transcribe(
            str(path), language=config.WHISPER_LANGUAGE, vad_filter=True
        )
        transcript = " ".join(
            segment.text.strip() for segment in segments if segment.text.strip()
        )
        if not transcript:
            raise ValueError("The recording has no identifiable speech.")
    with write() as db:
        if not still_owns(db, job):
            return
        if not db.execute(
            "UPDATE audio SET transcript=? WHERE id=? AND discarded=0",
            (transcript, audio["id"]),
        ).rowcount:
            return
        complete(db, job)
    cleanup_path(path)


async def compute_summary(job: sqlite3.Row, previous: dict) -> str:
    with read() as db:
        records = (
            (f"№{row['seq']} ({row['role']}): ", row["text"])
            for row in history_rows(
                db, job["chat_id"], job["base_seq"], job["target_seq"]
            )
        )
        scope = ChargeScope(job["chat_id"], job["attempt_id"], job_id=job["id"])
        return await compress(previous["text"], records, scope)


def summarize_history(job: sqlite3.Row) -> None:
    with read() as db:
        previous = summary_at(db, job["chat_id"], job["target_seq"])
    if previous["version"] != job["base_version"]:
        # Another job already made progress through this range. The API can
        # schedule any portion still needed from the newer checkpoint.
        with write() as db:
            if still_owns(db, job):
                complete(db, job)
        return
    result = asyncio.run(compute_summary(job, previous))
    with write() as db:
        if not still_owns(db, job):
            return
        latest = summary_at(db, job["chat_id"], job["target_seq"])
        if (
            latest["version"] == job["base_version"]
            and latest["covered_through_seq"] == job["base_seq"]
        ):
            version = db.execute(
                "SELECT COALESCE(MAX(version), 0)+1 FROM summaries WHERE chat_id=?",
                (job["chat_id"],),
            ).fetchone()[0]
            db.execute(
                "INSERT INTO summaries (chat_id, version, covered_through_seq, text) VALUES (?, ?, ?, ?)",
                (job["chat_id"], version, job["target_seq"], result),
            )
        complete(db, job)


def renew_job(job: sqlite3.Row, stopped: threading.Event) -> None:
    while not stopped.wait(6):
        try:
            with write() as db:
                now = time.time()
                renewed = db.execute(
                    """UPDATE jobs SET lease_until=? WHERE id=? AND status='running'
                       AND attempt_id=? AND lease_until>?""",
                    (now + JOB_LEASE, job["id"], job["attempt_id"], now),
                ).rowcount
                if not renewed:
                    return
        except sqlite3.OperationalError:
            LOGGER.warning("Could not renew a job lease.")


def run_job(job_id: str, delivery_id: str) -> None:
    job = claim(job_id, delivery_id)
    if job is None:
        return
    stopped = threading.Event()
    heartbeat = threading.Thread(target=renew_job, args=(job, stopped), daemon=True)
    heartbeat.start()
    try:
        if job["kind"] == "audio":
            transcribe(job)
        else:
            summarize_history(job)
    except BudgetError as exc:
        with write() as db:
            if still_owns(db, job):
                pricing_unavailable = exc.detail["code"] == "budget_pricing_unavailable"
                db.execute(
                    """UPDATE jobs SET status='failed', attempt_id=NULL, lease_until=NULL,
                           error=?, budget_denial_revision=?, budget_required_nano=?, next_dispatch=?
                       WHERE id=?""",
                    (
                        encode(exc.detail),
                        exc.revision,
                        exc.required_nano,
                        time.time() + PRICING_RETRY_COOLDOWN
                        if pricing_unavailable
                        else 0,
                        job["id"],
                    ),
                )
    except Exception as exc:  # noqa: BLE001 - third-party failures must update the durable job
        # Keep provider output, conversation text and filesystem details out of logs.
        LOGGER.warning("Job %s failed (%s)", job["id"], type(exc).__name__)
        with write() as db:
            if owned := still_owns(db, job):
                failure(db, owned)
    finally:
        stopped.set()
        heartbeat.join()


def recover_outbox() -> list[sqlite3.Row]:
    now = time.time()
    with write() as db:
        for job in db.execute(
            "SELECT * FROM jobs WHERE status='running' AND lease_until<=?", (now,)
        ).fetchall():
            failure(db, job)
        return db.execute(
            "SELECT * FROM jobs WHERE status='queued' AND next_dispatch<=? ORDER BY created_at LIMIT 100",
            (now,),
        ).fetchall()


def dispatch(connection: Redis, job: sqlite3.Row) -> None:
    queue = Queue(queue_name(job["kind"]), connection=connection)
    if job["delivery_id"]:
        try:
            rq_job = Job.fetch(job["delivery_id"], connection=connection)
            status = rq_job.get_status()
            if status == "started" or (
                status == "queued" and queue.get_job_position(rq_job.id) is not None
            ):
                with write() as db:
                    db.execute(
                        "UPDATE jobs SET next_dispatch=? WHERE id=? AND status='queued' AND delivery_id=?",
                        (time.time() + 4, job["id"], job["delivery_id"]),
                    )
                return
        except NoSuchJobError:
            pass
    # Commit the delivery identity first. A crash between this commit and RQ
    # enqueue leaves a queued SQLite job that reconciles after this short delay.
    delivery_id = new_id()
    now = time.time()
    with write() as db:
        reserved = db.execute(
            "UPDATE jobs SET delivery_id=?, next_dispatch=? WHERE id=? AND status='queued' AND next_dispatch<=?",
            (delivery_id, now + 4, job["id"], now),
        ).rowcount
    if reserved:
        queue.enqueue(
            "psyholuh.jobs.run_job",
            job["id"],
            delivery_id,
            job_id=delivery_id,
            job_timeout=JOB_TIMEOUTS[job["kind"]],
            result_ttl=120,
            failure_ttl=300,
        )


def cleanup_audio() -> None:
    with read() as db:
        states = {
            audio_path(row["id"], row["extension"]).name: bool(
                row["discarded"] or row["transcript"] is not None
            )
            for row in db.execute(
                "SELECT id, extension, discarded, transcript FROM audio"
            )
        }
    grace_cutoff = time.time() - 3600
    for path in config.AUDIO_DIR.iterdir():
        try:
            if not path.is_file():
                continue
            discard = states.get(path.name)
            if discard or (discard is None and path.stat().st_mtime < grace_cutoff):
                cleanup_path(path)
        except FileNotFoundError:
            continue


def reconcile(connection: Redis) -> None:
    last_cleanup = 0.0
    while True:
        try:
            if time.monotonic() - last_cleanup >= 60:
                cleanup_audio()
                last_cleanup = time.monotonic()
            for job in recover_outbox():
                dispatch(connection, job)
        except (RedisError, sqlite3.OperationalError, OSError) as exc:
            LOGGER.warning("Reconciliation will retry (%s).", type(exc).__name__)
        time.sleep(1)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument("service", choices=("audio", "memory", "reconcile"))
    service = parser.parse_args().service
    initialize()
    connection = redis_connection()
    if service == "reconcile":
        reconcile(connection)
    else:
        Worker([queue_name(service)], connection=connection).work()


if __name__ == "__main__":
    main()
