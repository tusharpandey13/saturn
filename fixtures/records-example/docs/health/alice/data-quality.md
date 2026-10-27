---
title: Alice data quality (synthetic)
generated: partial
---

# Alice: data quality

Facts as written; not advice; doctors decide.

<!-- gen:quality start -->
_Generated from the KB on 2026-10-27 (data as of 2026-06-10; 9 facts). Don't edit inside this block; see AGENTS.md._

### Conflicts between sources (1)

Two sources give different values for the same test on the same day (`v_conflicts`). Both are shown; neither is chosen. **To resolve:** check both page images; if one is a misread, add a corrected fact with `supersedes` (never edit the old row); if both are as printed, leave both and ask the doctor which applies. Each side shows who issued it, with role, specialty and register/accreditation check as recorded; this is context for the doctor, never a way to pick a side.

| Day | Test | Method | Value A | Issued by A | Fact A · source | Value B | Issued by B | Fact B · source |
|---|---|---|---|---|---|---|---|---|
| 2026-03-12 | Potassium |  | 5.5 | not recorded | `alice:fact:2026-03-12-example-lab-lft-rft-whatsapp-copy.potassium` · `sources/alice/documents/2026-03-12-example-lab-lft-rft-whatsapp-copy.md` | 5.7 | Example Lab (Diagnostic lab; Example Accreditor full) (no named doctor recorded) | `alice:fact:2026-03-12-example-lab-lft-rft.potassium` · `sources/alice/documents/2026-03-12-example-lab-lft-rft.md` p.2 |

### Documents that contradict themselves (1)

Tagged at extraction (`internal-contradiction` / `text-table-mismatch`). **To resolve:** only the issuing doctor or lab can say which part is right; each is a question for that doctor, not something to pick here.

| Day | What | Value | Tag | Quote | Fact id · source |
|---|---|---|---|---|---|
| 2026-03-12 | Sodium | 138 | internal-contradiction | SODIUM 138 | `alice:fact:2026-03-12-example-lab-lft-rft.sodium` · `sources/alice/documents/2026-03-12-example-lab-lft-rft.md` p.2 |

### Needs a human (7)

From `v_needs_human`. Query the rows with `sqlite3 data/kb.sqlite "SELECT reason, id, what, uncertain_ref FROM v_needs_human WHERE ns = 'alice'"`.

| Reason | Rows | What it means and how to clear it |
|---|---|---|
| alert-input | 3 | a value that feeds bot alerts (weight, BP, pulse, SpO2, K, Na, creatinine). Check it against the page and set `verification: human`. |
| medicine | 2 | a medicine statement not yet checked by a human against the page or strip. Check it and set `verification: human` in a superseding row. |
| uncertain | 2 | an open hard read (`uncertain_ref`). Resolve it in `docs/log/hard-reads/`, then add a superseding row with the settled value and no `uncertain_ref`. |

Open hard reads cited by active facts: G-01 (2).

### Corrections on record (0)

None.
<!-- gen:quality end -->
