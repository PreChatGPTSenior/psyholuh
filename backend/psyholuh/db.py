import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from . import config

MIGRATIONS = sorted(Path(__file__).with_name("migrations").glob("*.sql"))
MESSAGE_FIELDS = "id, chat_id, seq, role, text, status, created_at, request_id, mode, model_id, audio_id"


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False):
        self.status = status
        self.detail = {"code": code, "message": message, "retryable": retryable}
        super().__init__(message)


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def new_id() -> str:
    return uuid4().hex


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(config.DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


@contextmanager
def read() -> Iterator[sqlite3.Connection]:
    with closing(connect()) as db:
        db.execute("BEGIN")
        yield db


@contextmanager
def write() -> Iterator[sqlite3.Connection]:
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        yield db


def initialize() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.AUDIO_DIR.mkdir(exist_ok=True)
    with closing(connect()) as db:
        db.execute("PRAGMA journal_mode=WAL")
    # Each numbered migration commits alongside its version. Read user_version
    # after obtaining the write lock so simultaneous service starts are safe.
    with write() as db:
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version > len(MIGRATIONS):
            raise RuntimeError("Database schema was created by a newer release.")
        for number, migration in enumerate(MIGRATIONS, start=1):
            if number <= version:
                continue
            statement = ""
            for line in migration.read_text(encoding="utf-8").splitlines(keepends=True):
                statement += line
                if sqlite3.complete_statement(statement):
                    db.execute(statement)
                    statement = ""
            db.execute(f"PRAGMA user_version={number}")


def get_chat(db: sqlite3.Connection, chat_id: str) -> sqlite3.Row:
    found = db.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if found is None:
        raise APIError(404, "chat_not_found", "Беседа не найдена.")
    return found


def active_chat(db: sqlite3.Connection) -> str | None:
    return db.execute("SELECT active_chat_id FROM installation WHERE id=1").fetchone()[
        0
    ]


def require_active(db: sqlite3.Connection, chat_id: str) -> None:
    if active_chat(db) != chat_id:
        raise APIError(409, "inactive_chat", "Сначала откройте эту беседу.")


def activate(db: sqlite3.Connection, chat_id: str) -> dict:
    get_chat(db, chat_id)
    db.execute("UPDATE installation SET active_chat_id=? WHERE id=1", (chat_id,))
    db.execute("UPDATE chats SET updated_at=? WHERE id=?", (utc_now(), chat_id))
    return dict(get_chat(db, chat_id))


def expire_generations(db: sqlite3.Connection, chat_id: str) -> None:
    db.execute(
        """UPDATE messages SET status='interrupted', attempt_id=NULL, lease_until=NULL
           WHERE chat_id=? AND status='streaming' AND lease_until<=?""",
        (chat_id, time.time()),
    )


def insert_message(
    db: sqlite3.Connection,
    *,
    chat_id: str,
    seq: int,
    role: str,
    text: str,
    request_id: str | None,
    mode: str | None,
    model_id: str | None,
    status: str = "complete",
    audio_id: str | None = None,
    attempt_id: str | None = None,
    created_at: str | None = None,
) -> sqlite3.Row:
    message_id = new_id()
    db.execute(
        """INSERT INTO messages
           (id, chat_id, seq, role, text, status, created_at, request_id, mode,
            model_id, audio_id, attempt_id, lease_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            message_id,
            chat_id,
            seq,
            role,
            text,
            status,
            created_at or utc_now(),
            request_id,
            mode,
            model_id,
            audio_id,
            attempt_id,
            time.time() + config.LEASE_SECONDS if attempt_id else None,
        ),
    )
    return get_message(db, message_id)


def get_message(db: sqlite3.Connection, message_id: str) -> sqlite3.Row:
    return db.execute(
        f"SELECT {MESSAGE_FIELDS} FROM messages WHERE id=?", (message_id,)
    ).fetchone()
