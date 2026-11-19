import re
import sqlite3
import time
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import Literal

from . import config
from .db import APIError, encode, new_id, utc_now, write

NANO = 10**9
MAX_LIMIT = 1_000_000 * NANO
MAX_CALL_AMOUNT = 10**18
BUDGET_CODES = ("budget_required", "budget_exceeded", "budget_pricing_unavailable")
LIMIT_PATTERN = re.compile(r"[0-9]+(?:\.[0-9]{1,9})?")
CATEGORY = Literal["reply", "compression"]


class BudgetError(APIError):
    def __init__(self, code: str, revision: int, required_nano: int | None = None):
        message = {
            "budget_required": "Укажите общий бюджет OpenRouter в настройках.",
            "budget_exceeded": "Для этого запроса недостаточно доступного бюджета OpenRouter.",
            "budget_pricing_unavailable": "Не удалось проверить стоимость запроса OpenRouter. Попробуйте снова.",
        }[code]
        super().__init__(
            503 if code == "budget_pricing_unavailable" else 409, code, message, True
        )
        self.revision = revision
        self.required_nano = required_nano


@dataclass(frozen=True)
class ChargeScope:
    chat_id: str
    attempt_id: str
    assistant_id: str | None = None
    job_id: str | None = None

    def require_owner(self, db: sqlite3.Connection) -> None:
        if self.assistant_id is not None:
            where = "messages WHERE id=? AND chat_id=? AND status='streaming'"
            resource_id = self.assistant_id
        else:
            where = (
                "jobs WHERE id=? AND chat_id=? AND status='running' AND kind='memory'"
            )
            resource_id = self.job_id
        if not db.execute(
            f"SELECT 1 FROM {where} AND attempt_id=? AND lease_until>?",
            (resource_id, self.chat_id, self.attempt_id, time.time()),
        ).fetchone():
            raise APIError(
                409, "attempt_expired", "Попытка устарела. Повторите запрос.", True
            )


@dataclass(frozen=True)
class PriceQuote:
    prompt_tokens: int
    completion_tokens: int
    reserved_nano: int
    routing: dict
    expires_at: float


def parse_limit(text: str) -> int:
    if len(text) > 17 or not LIMIT_PATTERN.fullmatch(text):
        raise APIError(
            422,
            "invalid_budget",
            "Укажите сумму в долларах с точностью до девяти знаков.",
        )
    amount = int(Decimal(text) * NANO)
    if amount > MAX_LIMIT:
        raise APIError(
            422, "invalid_budget", "Бюджет не может превышать 1 000 000 долларов."
        )
    return amount


def decimal_amount(value) -> Decimal:
    if (
        isinstance(value, bool)
        or not isinstance(value, (Decimal, str, int))
        or len(str(value)) > 80
    ):
        raise ValueError("Invalid provider amount")
    try:
        amount = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("Invalid provider amount") from exc
    if not amount.is_finite() or amount < 0:
        raise ValueError("Invalid provider amount")
    return amount


def charge_amount(value) -> int:
    amount = decimal_amount(value)
    if amount > MAX_CALL_AMOUNT // NANO:
        raise ValueError("Provider amount too large")
    return int(amount.quantize(Decimal("0.000000001"), rounding=ROUND_CEILING) * NANO)


def usd(amount: int | None) -> str | None:
    if amount is None:
        return None
    whole, fraction = divmod(amount, NANO)
    return f"{whole}.{fraction:09d}".rstrip("0").rstrip(".") if fraction else str(whole)


def totals(db: sqlite3.Connection, chat_id: str | None = None) -> tuple[int, int, int]:
    query = """SELECT category, state, reserved_nano, settled_nano
               FROM openrouter_charges WHERE state IN ('pending', 'settled')"""
    rows = (
        db.execute(query)
        if chat_id is None
        else db.execute(query + " AND chat_id=?", (chat_id,))
    )
    replies = compression = pending = 0
    for row in rows:
        if row["state"] == "pending":
            pending += row["reserved_nano"]
        elif row["category"] == "reply":
            replies += row["settled_nano"]
        else:
            compression += row["settled_nano"]
    return replies, compression, pending


def settings(db: sqlite3.Connection) -> tuple[int | None, int]:
    row = db.execute(
        "SELECT openrouter_budget_limit_nano, openrouter_budget_revision FROM installation WHERE id=1"
    ).fetchone()
    return row[0], row[1]


def budget_view(db: sqlite3.Connection) -> dict:
    limit, _ = settings(db)
    replies, compression, pending = totals(db)
    spent = replies + compression
    return {
        "limit_usd": usd(limit),
        "spent_usd": usd(spent),
        "reserved_usd": usd(pending),
        "available_usd": usd(max(0, limit - spent - pending))
        if limit is not None
        else None,
    }


def update_budget(db: sqlite3.Connection, limit: int) -> dict:
    db.execute(
        """UPDATE installation SET openrouter_budget_limit_nano=?,
           openrouter_budget_revision=openrouter_budget_revision+1 WHERE id=1""",
        (limit,),
    )
    return budget_view(db)


def chat_costs(db: sqlite3.Connection, chat_id: str) -> dict:
    replies, compression, pending = totals(db, chat_id)
    row = db.execute(
        """SELECT m.id, c.state, c.settled_nano
           FROM messages m LEFT JOIN openrouter_charges c ON c.id=m.reply_charge_id
           WHERE m.chat_id=? AND m.role='assistant' AND m.status='complete'
           ORDER BY m.seq DESC LIMIT 1""",
        (chat_id,),
    ).fetchone()
    return {
        "total_usd": usd(replies + compression),
        "replies_usd": usd(replies),
        "compression_usd": usd(compression),
        "reserved_usd": usd(pending),
        "last_reply": {
            "message_id": row["id"],
            "cost_usd": usd(0 if config.DEMO else row["settled_nano"]),
            "pending": row["state"] == "pending",
        }
        if row
        else None,
    }


def eligible(db: sqlite3.Connection, model: str, amount: int = 0) -> int:
    limit, revision = settings(db)
    if limit is None:
        raise BudgetError("budget_required", revision)
    if model == config.FREE_ROUTER and amount == 0:
        return revision
    replies, compression, pending = totals(db)
    if not limit or replies + compression + pending + amount > limit:
        raise BudgetError("budget_exceeded", revision, max(1, amount))
    return revision


def reserve(
    scope: ChargeScope, category: CATEGORY, model: str, quote: PriceQuote
) -> str:
    charge_id = new_id()
    with write() as db:
        scope.require_owner(db)
        revision = eligible(db, model, quote.reserved_nano)
        if time.monotonic() >= quote.expires_at:
            raise BudgetError("budget_pricing_unavailable", revision)
        db.execute(
            """INSERT INTO openrouter_charges
               (id, chat_id, category, assistant_id, job_id, attempt_id, model_id,
                prompt_tokens_bound, completion_tokens_bound, routing, reserved_nano, state, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (
                charge_id,
                scope.chat_id,
                category,
                scope.assistant_id,
                scope.job_id,
                scope.attempt_id,
                model,
                quote.prompt_tokens,
                quote.completion_tokens,
                encode(quote.routing),
                quote.reserved_nano,
                utc_now(),
            ),
        )
    return charge_id


def observe(charge_id: str, generation_id: str | None, amount: int | None) -> None:
    if generation_id is None and amount is None:
        return
    with write() as db:
        if amount is None:
            db.execute(
                """UPDATE openrouter_charges SET provider_generation_id=?, next_check_at=?
                   WHERE id=? AND provider_generation_id IS NULL""",
                (generation_id, time.time() + 30, charge_id),
            )
        else:
            db.execute(
                """UPDATE openrouter_charges SET state='settled', settled_nano=?, resolved_at=?,
                       provider_generation_id=COALESCE(provider_generation_id, ?), next_check_at=NULL
                   WHERE id=? AND state='pending'""",
                (amount, utc_now(), generation_id, charge_id),
            )


def release_unsent(charge_id: str) -> None:
    with write() as db:
        db.execute(
            """UPDATE openrouter_charges SET state='released', resolved_at=?
               WHERE id=? AND state='pending' AND provider_generation_id IS NULL""",
            (utc_now(), charge_id),
        )


def claim_due() -> list[tuple[str, str]]:
    now = time.time()
    with write() as db:
        rows = db.execute(
            """SELECT id, provider_generation_id, check_attempts FROM openrouter_charges
               WHERE state='pending' AND provider_generation_id IS NOT NULL AND next_check_at<=?
               ORDER BY next_check_at LIMIT 4""",
            (now,),
        ).fetchall()
        for row in rows:
            delay = min(60 * 2 ** min(row["check_attempts"], 8), 6 * 3600)
            db.execute(
                "UPDATE openrouter_charges SET check_attempts=check_attempts+1, next_check_at=? WHERE id=?",
                (now + delay, row["id"]),
            )
        return [(row["id"], row["provider_generation_id"]) for row in rows]
