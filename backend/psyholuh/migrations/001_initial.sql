CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'listen' CHECK (mode IN ('listen', 'analyze')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE installation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_chat_id TEXT REFERENCES chats(id)
);
INSERT INTO installation (id) VALUES (1);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    seq INTEGER NOT NULL CHECK (seq > 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'interrupted')),
    created_at TEXT NOT NULL,
    request_id TEXT,
    mode TEXT CHECK (mode IN ('listen', 'analyze')),
    model_id TEXT,
    audio_id TEXT,
    attempt_id TEXT,
    lease_until REAL,
    evidence TEXT,
    completed_at TEXT,
    UNIQUE (chat_id, seq),
    UNIQUE (chat_id, request_id, role)
);
CREATE UNIQUE INDEX one_generation_per_chat ON messages (chat_id) WHERE status = 'streaming';

CREATE VIRTUAL TABLE message_search USING fts5(
    chat_id UNINDEXED, message_id UNINDEXED, text, tokenize='unicode61'
);
CREATE TRIGGER message_search_insert AFTER INSERT ON messages WHEN NEW.status = 'complete'
BEGIN
    INSERT INTO message_search (chat_id, message_id, text)
    VALUES (NEW.chat_id, NEW.id, NEW.text);
END;
CREATE TRIGGER message_search_complete AFTER UPDATE OF status ON messages
WHEN NEW.status = 'complete' AND OLD.status != 'complete'
BEGIN
    INSERT INTO message_search (chat_id, message_id, text)
    VALUES (NEW.chat_id, NEW.id, NEW.text);
END;

CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    replaces_message_id TEXT REFERENCES messages(id),
    text TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('event', 'preference', 'open_topic', 'assumption', 'correction')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'assistant')),
    topic TEXT,
    observed_at TEXT NOT NULL,
    superseded_by_seq INTEGER
);
CREATE INDEX notes_by_chat ON notes (chat_id, observed_at);
CREATE VIRTUAL TABLE note_search USING fts5(
    chat_id UNINDEXED, note_id UNINDEXED, text, tokenize='unicode61'
);
CREATE TRIGGER note_search_insert AFTER INSERT ON notes
BEGIN
    INSERT INTO note_search (chat_id, note_id, text) VALUES (NEW.chat_id, NEW.id, NEW.text);
END;

CREATE TABLE summaries (
    chat_id TEXT NOT NULL REFERENCES chats(id),
    version INTEGER NOT NULL,
    covered_through_seq INTEGER NOT NULL CHECK (covered_through_seq > 0),
    text TEXT NOT NULL,
    valid INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (chat_id, version)
);

CREATE UNIQUE INDEX valid_summary_boundary ON summaries (chat_id, covered_through_seq) WHERE valid=1;

CREATE TABLE audio (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    extension TEXT NOT NULL,
    transcript TEXT,
    discarded INTEGER NOT NULL DEFAULT 0 CHECK (discarded IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    kind TEXT NOT NULL CHECK (kind IN ('audio', 'memory')),
    audio_id TEXT UNIQUE REFERENCES audio(id),
    base_version INTEGER,
    base_seq INTEGER,
    target_seq INTEGER,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    attempt_id TEXT,
    lease_until REAL,
    delivery_id TEXT,
    next_dispatch REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX jobs_dispatch ON jobs (status, next_dispatch);
CREATE INDEX jobs_chat ON jobs (chat_id, kind, created_at);
CREATE UNIQUE INDEX memory_job_range ON jobs (chat_id, base_version, target_seq)
WHERE kind='memory' AND status IN ('queued', 'running');
