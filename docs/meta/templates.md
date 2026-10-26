# Page templates

Approved 26-Oct-2026 with an independent doc review (records repo). Rules: [records-guide.md](../records-guide.md).

## Front matter (every curated page)

```yaml
---
title: Alice: current medicines
audience: family, doctor        # one or two of: family | doctor | engineer | agent
type: reference                 # tutorial | how-to | reference | explanation
owner: maintainer               # human accountable; agents edit, owner approves
last_reviewed: 2026-10-26       # bump only after a full read-through
review_every: 30d               # health 30d (meds 7d while unstable); platform 90d
status: current                 # current | draft | frozen | stub
sources: [alice:q:0001, sources/alice/documents/…]   # KB ids first; paths where no KB row exists yet
generated: false                # true = do not hand-edit outside <!-- manual --> blocks
---
```

Briefs add `regenerate: false` (set to `true` when an input changes).

## Bodies

| Page | Body |
|---|---|
| `summary.md` | IPS order: one-line situation; active problems; current medicines (link); allergies; devices/procedures; recent events (90 days); results pending; upcoming visits; care team (link) |
| `medications.md` | One table: drug (brand → generic), dose and timing, for what, prescriber and date, **status** (`prescribed` / `strip-seen` / `patient-confirmed` / `clinician-reconciled` / `stopped`), last checked, source. Then "Discrepancies to resolve", then "Stopped / history" |
| `problems.md` | One table: problem, status (active / inactive / resolved), since, treating doctor, key evidence, open question ids |
| `timeline.md` | One table: date, type (visit, test, admission, medicine change, event), what, where/who, source. Newest first |
| `care-team.md` | Doctors, hospitals, labs: role, last contact, IDs, source |
| `questions.md` | Ids `<person>:q:NNNN`; audience; date raised; status (`open` / `asked` / `answered` / `dropped`); answer with source. Answered and dropped items at the bottom |
| `family/actions.md` | Ids `<ns>:act:NNNN`; owner; due; status; link to the question or page it serves |
| Brief (SBAR) | Header (name, age, date prepared, preparer, "facts as written, not advice"). **S** why this visit (≤3 lines). **B** problems, key series, current medicines with status. **A** what doctors have recorded, and conflicts. **R** top 5–10 questions. One printed page. Regenerated, never patched with banners |
| Platform page | Diátaxis type in front matter; how-tos are numbered steps with a "done when" line; ADRs use MADR (Context, Options, Decision, Consequences, Status, Supersedes / Superseded-by) |
| Log entry | `YYYY-MM-DD-<slug>.md`; header with date, author, inputs, outputs and "promoted to:" links. Never edited after the day, except a "Superseded by" line |

Every health page carries: "Facts as written; not advice; doctors decide."
