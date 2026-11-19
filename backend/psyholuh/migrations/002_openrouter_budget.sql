ALTER TABLE installation ADD COLUMN openrouter_budget_limit_nano INTEGER CHECK (openrouter_budget_limit_nano >= 0);
ALTER TABLE installation ADD COLUMN openrouter_budget_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN budget_denial_revision INTEGER;

CREATE TABLE openrouter_charges (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    category TEXT NOT NULL CHECK (category IN ('reply', 'compression')),
    assistant_id TEXT REFERENCES messages(id),
    job_id TEXT REFERENCES jobs(id),
    attempt_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    prompt_tokens_bound INTEGER NOT NULL,
    completion_tokens_bound INTEGER NOT NULL,
    routing TEXT NOT NULL,
    reserved_nano INTEGER NOT NULL CHECK (reserved_nano >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'released')),
    settled_nano INTEGER CHECK (settled_nano >= 0),
    provider_generation_id TEXT,
    next_check_at REAL,
    check_attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK ((state = 'settled') = (settled_nano IS NOT NULL)),
    CHECK (category != 'reply' OR (assistant_id IS NOT NULL AND job_id IS NULL)),
    CHECK ((assistant_id IS NOT NULL) != (job_id IS NOT NULL))
);
CREATE UNIQUE INDEX openrouter_one_reply_charge_per_attempt
    ON openrouter_charges (assistant_id, attempt_id) WHERE category='reply';
CREATE INDEX openrouter_charges_by_chat ON openrouter_charges (chat_id);
CREATE INDEX openrouter_pending_checks ON openrouter_charges (next_check_at) WHERE state='pending';
ALTER TABLE messages ADD COLUMN reply_charge_id TEXT REFERENCES openrouter_charges(id);
