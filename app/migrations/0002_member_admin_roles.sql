-- v0.3.0: everyone is a member; admin = a member plus ops privileges (ops alerts and digest failures by private DM;
-- manages the allowlist and settings). Replaces the patient/caregiver roles: patient -> member, caregiver -> admin.
-- SQLite cannot alter a CHECK, so persons is rebuilt. Rows, ids, names, sender ids and created_at are kept; sender_id
-- stays UNIQUE. No other table references persons by foreign key (inbox.person_id is a plain id). An unknown role makes
-- the INSERT fail the new CHECK, so the migration aborts and changes nothing (wrangler runs a migration as one unit).
CREATE TABLE persons_new (
  id          TEXT PRIMARY KEY,                -- person id (records.yaml d1_person_map maps it to a KB namespace)
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  sender_id   TEXT NOT NULL UNIQUE,            -- Telegram user id
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO persons_new (id, name, role, sender_id, created_at)
  SELECT id, name, CASE role WHEN 'patient' THEN 'member' WHEN 'caregiver' THEN 'admin' ELSE role END, sender_id, created_at
  FROM persons;
DROP TABLE persons;
ALTER TABLE persons_new RENAME TO persons;
