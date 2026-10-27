-- Clinical KB schema, ADR 007 (simplified model; amends ADR 004). Canonical data = data/**/*.ndjson in git; this DDL
-- builds data/kb.sqlite (tools/kb/build) and is the future D1 replica schema. Each NDJSON line has "rt" = table name.
-- Three concepts: source (anything received), fact (every clinical statement, kind = observation|medication|condition|
-- event), ref (drug|code|party). person is the namespace registry. Questions/answers/actions are NOT in the KB.
--
-- Ids: <ns>:src:<local> | <ns>:fact:<local> | ref:<drug|code|party>:<local>
--   ns = a namespace from the records repo's records.yaml (a person, or a shared one such as family);
--   local = [a-z0-9][a-z0-9.-]*, date-first where dated, no page numbers.
--   Regex (built at runtime by tools/kb/build from records.yaml):
--   ^(?:(<ns>|...):(src|fact)|ref:(drug|code|party)):([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$
--   Namespace membership is checked in code (records.yaml), not in this DDL, so the schema carries no person names.
-- fact.data is a JSON object validated per kind by schema/<kind>.schema.json (ref.data likewise per ref kind).
-- Times: ISO-8601 with +05:30; at_precision minute|day|month|year. JSON-valued fields are stored as JSON text.
-- Facts are never edited in place: a correction is a new row with supersedes = old id; the old row -> superseded.

PRAGMA foreign_keys = ON;

CREATE TABLE person (  -- namespace registry (a shared namespace has no row: it is not a person)
  id TEXT PRIMARY KEY,                                  -- a non-shared namespace in records.yaml (checked in code)
  name TEXT NOT NULL, relation TEXT, dob TEXT, sex TEXT CHECK (sex IN ('F','M')),
  identifiers TEXT, name_variants TEXT, note TEXT
);

CREATE TABLE ref (  -- drug (brand -> generic), code (LOINC etc.), party (organisation / practitioner)
  id TEXT PRIMARY KEY, ns TEXT NOT NULL CHECK (ns = 'ref'),
  kind TEXT NOT NULL CHECK (kind IN ('drug','code','party')),
  name TEXT NOT NULL,                                   -- drug brand (or generic), code display, party name
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  recorded_by TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted')),
  supersedes TEXT REFERENCES ref(id), tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), note TEXT,
  CHECK (id LIKE 'ref:' || kind || ':%')
);

CREATE TABLE source (  -- document, photo, voice note, Telegram message, chat line
  id TEXT PRIMARY KEY, ns TEXT NOT NULL CHECK (ns != 'ref'),
  kind TEXT NOT NULL CHECK (kind IN ('lab','rx','echo','ecg','imaging','discharge','consult','bill','photo','voice','chat',
                                     'telegram_msg','ai_summary','other')),
  path TEXT, sha256 TEXT, issued_at TEXT, received_at TEXT, sender TEXT,
  text_path TEXT,                                       -- OCR sidecar or transcript
  pages INTEGER,
  -- original > copy > recollection > ai_summary. recollection = a person's later account from memory (not a document)
  rank TEXT NOT NULL CHECK (rank IN ('original','copy','recollection','ai_summary')),
  external INTEGER CHECK (external IN (0,1)),          -- 1: the raw file at path lives outside git (note says where)
  duplicate_of TEXT REFERENCES source(id),
  org_id TEXT REFERENCES ref(id), practitioner_id TEXT REFERENCES ref(id),
  context_id TEXT REFERENCES fact(id),                  -- the visit/admission event it belongs to
  identifiers TEXT,
  recorded_by TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted')),
  supersedes TEXT REFERENCES source(id), tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), note TEXT,
  CHECK (id LIKE ns || ':src:%')
);

CREATE TABLE fact (  -- the envelope; kind-specific fields live in data
  id TEXT PRIMARY KEY, ns TEXT NOT NULL CHECK (ns != 'ref'),
  kind TEXT NOT NULL CHECK (kind IN ('observation','medication','condition','event')),
  at TEXT NOT NULL, at_precision TEXT NOT NULL CHECK (at_precision IN ('minute','day','month','year')),
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  source_id TEXT NOT NULL REFERENCES source(id), page INTEGER, locator TEXT,
  quote TEXT CHECK (quote IS NULL OR length(quote) <= 200),   -- verbatim
  context_id TEXT REFERENCES fact(id),
  verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','agent','human','patient','clinician')),
  verified_by TEXT, verified_at TEXT,
  uncertain_ref TEXT,                                   -- open hard-read id (replaces numeric confidence); null = settled
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted')),
  supersedes TEXT REFERENCES fact(id),
  recorded_by TEXT NOT NULL, created_at TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), note TEXT,
  CHECK (id LIKE ns || ':fact:%')
);
CREATE INDEX idx_fact_kind ON fact(ns, kind, at);
CREATE INDEX idx_fact_code ON fact(ns, json_extract(data, '$.code'), at) WHERE kind = 'observation';
CREATE INDEX idx_fact_source ON fact(source_id);

-- views ---------------------------------------------------------------------------------------------------
-- Ref aliases: every ref id -> the active ref that (transitively) supersedes it, or itself. A duplicate ref is merged
-- by marking it superseded and setting supersedes on the kept ref; facts keep the id they were written with.
CREATE VIEW v_ref_current AS
WITH RECURSIVE chain(id, current_id) AS (
  SELECT id, id FROM ref WHERE status != 'superseded'
  UNION
  SELECT r.supersedes, c.current_id FROM chain c JOIN ref r ON r.id = c.id WHERE r.supersedes IS NOT NULL)
SELECT id, current_id FROM chain;

-- Trend: every active observation of a code, oldest first, with its citation.  WHERE ns=? AND code='ref:code:potassium'
-- code is the current (alias-resolved) code; code_as_written is the id on the fact.
CREATE VIEW v_trend AS
SELECT f.ns, coalesce(rc.current_id, json_extract(f.data, '$.code')) AS code, f.at, f.at_precision,
       json_extract(f.data, '$.value_num') AS value_num, json_extract(f.data, '$.value_text') AS value_text,
       json_extract(f.data, '$.unit') AS unit, json_extract(f.data, '$.flag') AS flag,
       json_extract(f.data, '$.ref_text') AS ref_text, f.verification, f.uncertain_ref,
       f.source_id, f.page, f.quote, s.rank, f.id,
       json_extract(f.data, '$.body_site') AS body_site, json_extract(f.data, '$.method') AS method,
       json_extract(f.data, '$.components') AS components, json_extract(f.data, '$.code') AS code_as_written
FROM fact f JOIN source s ON s.id = f.source_id
LEFT JOIN v_ref_current rc ON rc.id = json_extract(f.data, '$.code')
WHERE f.kind = 'observation' AND f.status = 'active'
ORDER BY f.ns, code, f.at;

-- Latest value per ns and code (best source rank wins a same-time tie).
-- "Latest before X": query v_trend with at < X ORDER BY at DESC LIMIT 1.
CREATE VIEW v_latest AS
SELECT * FROM (
  SELECT t.*, ROW_NUMBER() OVER (PARTITION BY ns, code
           ORDER BY at DESC, CASE rank WHEN 'original' THEN 0 WHEN 'copy' THEN 1 WHEN 'recollection' THEN 2 ELSE 3 END) AS rn
  FROM v_trend t) WHERE rn = 1;

-- Facts that one document contradicts within itself (tagged internal-contradiction or text-table-mismatch at
-- extraction). They are listed here, not in v_conflicts.
CREATE VIEW v_internal_contradictions AS
SELECT f.ns, f.kind, substr(f.at, 1, 10) AS day,
       coalesce(json_extract(f.data, '$.code'), json_extract(f.data, '$.drug_id'), json_extract(f.data, '$.type'),
                json_extract(f.data, '$.text_as_written')) AS what,
       coalesce(json_extract(f.data, '$.value_num'), json_extract(f.data, '$.value_text'), json_extract(f.data, '$.status')) AS value,
       t.value AS tag, f.id, f.source_id, f.page, f.quote, f.note
FROM fact f, json_each(f.tags) t
WHERE f.status = 'active' AND t.value IN ('internal-contradiction', 'text-table-mismatch')
ORDER BY f.ns, day, f.id;

-- Conflicts: two sources disagree about the same measurement. Same ns, code (alias-resolved), day and body_site; the
-- same method/view (or one of them does not say); not two different clock times (those are separate readings); values
-- differ (numbers when both have one, else text; BP also compares diastolic). Pairs inside one source are left out:
-- a document that prints several sets, views or methods (Teichholz vs 4CH, before/after a dose) is not in conflict
-- with itself, and the real within-document contradictions are tagged and listed in v_internal_contradictions.
-- Copies (rank copy) that disagree with their original do appear.
CREATE VIEW v_conflicts AS
WITH t AS (
  SELECT v.* FROM v_trend v JOIN fact f ON f.id = v.id
  WHERE NOT EXISTS (SELECT 1 FROM json_each(f.tags)
                    WHERE value IN ('internal-contradiction', 'text-table-mismatch')))
SELECT a.ns, a.code, substr(a.at, 1, 10) AS day, a.body_site, coalesce(a.method, b.method) AS method,
       a.id AS id_a, coalesce(a.value_num, a.value_text) AS value_a, a.source_id AS source_a,
       b.id AS id_b, coalesce(b.value_num, b.value_text) AS value_b, b.source_id AS source_b
FROM t a JOIN t b
  ON a.ns = b.ns AND a.code = b.code AND a.id < b.id AND substr(a.at, 1, 10) = substr(b.at, 1, 10)
 AND a.source_id != b.source_id
 AND a.body_site IS b.body_site
 AND (a.method IS b.method OR a.method IS NULL OR b.method IS NULL)
 AND NOT (a.at_precision = 'minute' AND b.at_precision = 'minute' AND a.at != b.at)
WHERE CASE WHEN a.value_num IS NOT NULL AND b.value_num IS NOT NULL
           THEN a.value_num != b.value_num
             OR json_extract(a.components, '$.diastolic') IS NOT json_extract(b.components, '$.diastolic')
           ELSE coalesce(a.value_num, a.value_text) IS NOT coalesce(b.value_num, b.value_text) END;

-- Human queue: medicines (any statement not human/clinician-verified, or with an open hard read), anything uncertain
-- (open hard read or tag low-confidence), and observations that feed bot alerts (app/src/rules inputs).
CREATE VIEW v_needs_human AS
SELECT f.kind, f.id, f.ns,
       coalesce(json_extract(f.data, '$.brand'), json_extract(f.data, '$.code'), json_extract(f.data, '$.label'),
                json_extract(f.data, '$.text_as_written'), json_extract(f.data, '$.type')) AS what,
       f.source_id, f.page, f.uncertain_ref,
       CASE WHEN f.kind = 'medication' AND f.verification NOT IN ('human','clinician') THEN 'medicine'
            WHEN f.uncertain_ref IS NOT NULL THEN 'uncertain'
            WHEN EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value = 'low-confidence') THEN 'low-confidence'
            ELSE 'alert-input' END AS reason
FROM fact f
WHERE f.status = 'active' AND json_extract(f.data, '$.type') IS NOT 'context' AND (
      (f.kind = 'medication' AND f.verification NOT IN ('human','clinician'))
   OR f.uncertain_ref IS NOT NULL
   OR (f.verification NOT IN ('human','clinician') AND (
         EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value = 'low-confidence')
      OR (f.kind = 'observation' AND json_extract(f.data, '$.code') IN
          ('ref:code:weight','ref:code:bp','ref:code:pulse','ref:code:spo2','ref:code:potassium','ref:code:sodium','ref:code:creatinine')))));

-- Timeline for generators: events (visits, admissions, procedures, falls ...), every medication statement (status
-- changes) and key observations (printed H/L flags or alert inputs), per ns, ordered by time. Life-context events
-- (data.type context, ADR 010) are left out here and in v_needs_human: they render only in gen:context (v_context).
CREATE VIEW v_timeline AS
SELECT ns, at, at_precision, kind, what, label, id, source_id, verification, uncertain_ref FROM (
  SELECT ns, at, at_precision, kind, json_extract(data, '$.type') AS what,
         coalesce(json_extract(data, '$.label'), json_extract(data, '$.reason_text')) AS label,
         id, source_id, verification, uncertain_ref
  FROM fact WHERE status = 'active' AND kind = 'event' AND json_extract(data, '$.type') IS NOT 'context'
  UNION ALL
  SELECT ns, at, at_precision, kind, json_extract(data, '$.status'),
         trim(coalesce(json_extract(data, '$.brand'), json_extract(data, '$.drug_id')) || ' ' ||
              coalesce(json_extract(data, '$.strength'), '') || ' ' || coalesce(json_extract(data, '$.schedule_raw'), '')),
         id, source_id, verification, uncertain_ref
  FROM fact WHERE status = 'active' AND kind = 'medication'
  UNION ALL
  SELECT ns, at, at_precision, 'observation', code,
         coalesce(value_text, value_num || coalesce(' ' || unit, '')) || coalesce(' (' || flag || ')', ''),
         id, source_id, verification, uncertain_ref
  FROM v_trend
  WHERE flag IN ('H','L')
     OR code IN ('ref:code:weight','ref:code:bp','ref:code:pulse','ref:code:spo2','ref:code:potassium','ref:code:sodium','ref:code:creatinine'))
ORDER BY ns, at, kind, id;

-- Life-context bands (ADR 010): active context events that a view may show. Shadow rows (context_mode shadow) and
-- low-confidence rows are never shown. Association only: a view puts them alongside readings, never as a cause.
CREATE VIEW v_context AS
SELECT ns, at, coalesce(json_extract(data, '$.end'), substr(at, 1, 10)) AS end_at, json_extract(data, '$.category') AS category,
       json_extract(data, '$.summary') AS summary, json_extract(data, '$.intensity') AS intensity, id, source_id, tags
FROM fact f
WHERE kind = 'event' AND status = 'active' AND json_extract(data, '$.type') = 'context'
  AND NOT EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value IN ('shadow', 'low-confidence'))
ORDER BY ns, at, id;

-- Current medicines: the latest active statement per ns and drug (brand when no drug_id). Same day: stopped > taking
-- > dispensed > prescribed. med_status says what the statement is; verification says how well it was read.
-- Complete-list snapshot: an active event fact with data.type 'med-list-complete' (latest per ns) lists data.drug_ids.
-- When one exists, list_status is 'on-list' (drug in the snapshot; its latest statement stands), 'not-in-current-list'
-- (latest statement predates the snapshot day and the drug is not in it) or 'after-list' (not in it; stated on or after
-- the snapshot day); NULL when the ns has no snapshot. display_status = 'not-in-current-list' for those, else
-- med_status. Derived for display only; no fact is edited.
CREATE VIEW v_meds_current AS
WITH snap AS (
  SELECT ns, id, at, data FROM (
    SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.ns ORDER BY f.at DESC, f.created_at DESC, f.id DESC) AS rn
    FROM fact f WHERE f.kind = 'event' AND f.status = 'active' AND json_extract(f.data, '$.type') = 'med-list-complete')
  WHERE rn = 1),
latest AS (
  SELECT ns, drug, generic, brand, med_status, strength, schedule_raw, at, verification, uncertain_ref, id, source_id FROM (
    SELECT f.ns, coalesce(json_extract(f.data, '$.drug_id'), 'brand:' || lower(json_extract(f.data, '$.brand'))) AS drug,
           json_extract(d.data, '$.generic') AS generic, json_extract(f.data, '$.brand') AS brand,
           json_extract(f.data, '$.status') AS med_status, json_extract(f.data, '$.strength') AS strength,
           json_extract(f.data, '$.schedule_raw') AS schedule_raw, f.at, f.verification, f.uncertain_ref, f.id, f.source_id,
           ROW_NUMBER() OVER (PARTITION BY f.ns, coalesce(json_extract(f.data, '$.drug_id'), lower(json_extract(f.data, '$.brand')))
             ORDER BY f.at DESC, CASE json_extract(f.data, '$.status') WHEN 'stopped' THEN 0 WHEN 'taking' THEN 1
                                     WHEN 'dispensed' THEN 2 ELSE 3 END, f.created_at DESC) AS rn
    FROM fact f LEFT JOIN ref d ON d.id = json_extract(f.data, '$.drug_id')
    WHERE f.kind = 'medication' AND f.status = 'active')
  WHERE rn = 1),
tagged AS (
  SELECT l.*, s.id AS list_id, s.at AS list_at,
         CASE WHEN s.id IS NULL THEN NULL
              WHEN EXISTS (SELECT 1 FROM json_each(s.data, '$.drug_ids') WHERE value = l.drug) THEN 'on-list'
              WHEN substr(l.at, 1, 10) < substr(s.at, 1, 10) THEN 'not-in-current-list'
              ELSE 'after-list' END AS list_status
  FROM latest l LEFT JOIN snap s ON s.ns = l.ns)
SELECT ns, drug, generic, brand, med_status, strength, schedule_raw, at, verification, uncertain_ref, id, source_id,
       list_status, CASE list_status WHEN 'not-in-current-list' THEN list_status ELSE med_status END AS display_status,
       list_id, list_at
FROM tagged
ORDER BY ns, drug;
