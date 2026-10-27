-- D1 for the ingest-only Worker (ADR 005). D1 is a short-lived inbox, not a store of record: the daily batch
-- copies every row to git (data/telegram/raw/) and rows are pruned N days after that. Timestamps: ISO-8601 UTC.

-- Who may write. Seeded by hand at deploy (docs/platform/deploy.md). Roles: 0002_member_admin_roles.sql replaces patient/caregiver with member/admin.
CREATE TABLE persons (
  id          TEXT PRIMARY KEY,                -- person id, e.g. alice | bob | carol (records.yaml d1_person_map maps it to a KB namespace)
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('patient', 'caregiver')),
  sender_id   TEXT NOT NULL UNIQUE,            -- Telegram user id
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Allowed chats. In D1, not config, because a group upgrade to supergroup changes the chat id (migrate_to_chat_id).
CREATE TABLE chats (
  chat_id     TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  label       TEXT,                            -- free note only (ADR 011: chats are input-only; no digest target)
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per accepted Telegram update. Idempotency key: update_id (Telegram redelivers on non-2xx).
CREATE TABLE inbox (
  update_id     INTEGER PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  message_id    INTEGER NOT NULL,
  sender_id     TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('text', 'audio', 'image', 'document', 'other')),
  received_at   TEXT NOT NULL,                 -- message date (original send time, also for edits)
  raw           TEXT NOT NULL,                 -- the Telegram update, verbatim JSON
  media_key     TEXT,                          -- R2 key telegram/<file_unique_id>
  media_status  TEXT NOT NULL DEFAULT 'none' CHECK (media_status IN ('none', 'pending', 'stored', 'too_big')),
  ack           TEXT,                          -- the reply the Worker sent (deterministic, never LLM)
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
  done_at       TEXT,                          -- set by the batch once the row is committed to git
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_inbox_status ON inbox(status, update_id);
