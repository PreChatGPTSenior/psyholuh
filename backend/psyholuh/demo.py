from . import config
from .db import insert_message, write
from .memory import infer_note

CHAT_ID = "demo-friday"
CHAT_TITLE = "Встреча в пятницу"
CHAT_DATE = "2026-11-16T09:00:00Z"
DIALOGUE = [
    (
        "user",
        "У меня встреча с руководителем в среду. Хочу обсудить, как мы делим задачи.",
    ),
    (
        "assistant",
        "Похоже, тебе важно договориться о нагрузке и услышать другую сторону.",
    ),
    ("user", "Встречу перенесли со среды на пятницу. Обсудим распределение задач."),
    ("assistant", "У тебя появилось ещё время подумать, о чём хочется поговорить."),
    ("user", "Мне помогает после работы пройтись пешком."),
    ("assistant", "Прогулка даёт тебе немного пространства после рабочего дня."),
    ("user", "Вчера я гуляла в парке и впервые за неделю смогла спокойно посидеть."),
    ("assistant", "Похоже, этот тихий момент был для тебя важен."),
    ("user", "Написала подруге и рассказала ей, как прошла неделя."),
    ("assistant", "Как тебе было делиться с ней этим?"),
    ("user", "Сначала неловко. Потом стало легче."),
    ("assistant", "Приятно, когда разговор оставляет ощущение, что тебя услышали."),
    ("user", "Сегодня хочется закончить день пораньше и немного отдохнуть."),
    ("assistant", "Похоже, ты хорошо замечаешь, когда тебе нужна пауза."),
]


def seed() -> None:
    if not config.DEMO:
        return
    with write() as db:
        if db.execute("SELECT 1 FROM chats LIMIT 1").fetchone():
            return
        db.execute(
            "INSERT INTO chats (id, model_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (CHAT_ID, config.CLAUDE_MODEL, CHAT_TITLE, CHAT_DATE, CHAT_DATE),
        )
        for seq, (role, text) in enumerate(DIALOGUE, start=1):
            message = insert_message(
                db,
                chat_id=CHAT_ID,
                seq=seq,
                role=role,
                text=text,
                request_id=None,
                mode="listen",
                model_id=config.CLAUDE_MODEL if role == "assistant" else None,
                created_at=f"2026-11-16T09:{seq:02}:00Z",
            )
            infer_note(db, message)
        db.execute(
            "INSERT INTO summaries (chat_id, version, covered_through_seq, text) VALUES (?, 1, 6, ?)",
            (
                CHAT_ID,
                (
                    "Пользователь хочет обсудить нагрузку с руководителем. Встречу перенесли "
                    "со среды на пятницу. После работы пользователю помогают прогулки."
                ),
            ),
        )
        db.execute("UPDATE installation SET active_chat_id=? WHERE id=1", (CHAT_ID,))
