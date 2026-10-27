-- v0.3.0: subject attribution (ADR 009). A member may log for another member ("maa 116/47" sent by the father).
-- inbox.person_id stays the SENDER; subject_id is who the message is about (D1 person id), backfilled = person_id.
ALTER TABLE inbox ADD COLUMN subject_id TEXT;    -- set by the Worker from a name prefix; NULL (old rows) = the sender
UPDATE inbox SET subject_id = person_id WHERE subject_id IS NULL;
ALTER TABLE inbox ADD COLUMN ack_message_id INTEGER; -- the bot's echo, so an admin can reply to it with /for <name>

-- Name prefixes -> subject. Synced from the records repo (records.yaml aliases:) by the batch; not edited by hand.
CREATE TABLE aliases (
  alias       TEXT PRIMARY KEY,                -- lower-case, NFC
  person_id   TEXT NOT NULL,                   -- D1 person id of the subject
  display     TEXT NOT NULL,                   -- name in the echo ("Maa: BP 116/47 ✓")
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An admin's /for correction: the original sender is kept, the subject changes, and who and when are recorded.
-- The batch copies these to the records repo (data/telegram/subject-overrides.ndjson), which is the auditable copy.
CREATE TABLE subject_corrections (
  id          INTEGER PRIMARY KEY,             -- update_id of the /for command (idempotent on Telegram redelivery)
  update_id   INTEGER NOT NULL,                -- the corrected inbox row
  subject_id  TEXT NOT NULL,                   -- new subject (D1 person id)
  set_by      TEXT NOT NULL,                   -- the admin's D1 person id
  set_at      TEXT NOT NULL,
  reason      TEXT
);
