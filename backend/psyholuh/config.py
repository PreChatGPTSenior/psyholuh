import os
from pathlib import Path

DEMO = os.getenv("PSYHOLUH_DEMO", "1") == "1"
DATA_DIR = Path(os.getenv("PSYHOLUH_DATA_DIR", "./data")).resolve()
DB_PATH = DATA_DIR / ("demo.sqlite3" if DEMO else "personal.sqlite3")
AUDIO_DIR = DATA_DIR / ("demo-audio" if DEMO else "personal-audio")
REDIS_URL = os.getenv("PSYHOLUH_REDIS_URL", "redis://localhost:6379/0")
REDIS_NAMESPACE = f"psyholuh-{'demo' if DEMO else 'personal'}"
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
FREE_ROUTER = "openrouter/free"
CLAUDE_MODEL = (
    "demo/claude"
    if DEMO
    else os.getenv("PSYHOLUH_CLAUDE_MODEL", "anthropic/claude-sonnet-4.5")
)
DEEPSEEK_MODEL = (
    "demo/deepseek"
    if DEMO
    else os.getenv("PSYHOLUH_DEEPSEEK_MODEL", "deepseek/deepseek-v3.2")
)
SUMMARY_MODEL = os.getenv("PSYHOLUH_SUMMARY_MODEL", "") or DEEPSEEK_MODEL
WHISPER_MODEL = os.getenv("PSYHOLUH_WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("PSYHOLUH_WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("PSYHOLUH_WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.getenv("PSYHOLUH_WHISPER_LANGUAGE", "ru") or None
WHISPER_CACHE = os.getenv("PSYHOLUH_WHISPER_CACHE", str(DATA_DIR / "whisper"))
MODELS = [
    {"id": CLAUDE_MODEL, "label": "Claude"},
    {"id": DEEPSEEK_MODEL, "label": "DeepSeek"},
]
WINDOWS = {
    CLAUDE_MODEL: int(os.getenv("PSYHOLUH_CLAUDE_CONTEXT", "24000")),
    DEEPSEEK_MODEL: int(os.getenv("PSYHOLUH_DEEPSEEK_CONTEXT", "24000")),
}
SUMMARY_CONTEXT = int(os.getenv("PSYHOLUH_SUMMARY_CONTEXT", "16000"))
RESPONSE_TOKENS = 1200
LEASE_SECONDS = 120
DRAFT_LIMIT = 25 * 1024 * 1024
MAX_JOB_ATTEMPTS = 3

if min(*WINDOWS.values(), SUMMARY_CONTEXT) < 4096:
    raise RuntimeError("Configured context windows must be at least 4096 tokens.")
