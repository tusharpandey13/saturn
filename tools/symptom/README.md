# tools/symptom: symptom context cards

Design and test spec: [docs/design/symptom-context-card.md](../../docs/design/symptom-context-card.md). Stdlib Python;
no AI. Record and flag only: a card says what was written, what was recorded alongside (never as a cause), what US
labels mention, which rule-based warning signs apply (with a rule id and a tier), what to ask and what would close it.

| File | What |
|---|---|
| `cardlib.py` | builds one card per source with a new symptom (last 14 days) from the KB, the label cache, the maps and rules and the family context page; the word list |
| `sites.json` | body sites: triggers, label terms, at most 5 questions, closing rule, "ask a doctor before using" line |
| `rules.json` | person modifiers (from the KB) and warning-sign rules with tiers and NHS sources; `pending_clinician_signoff` |
| `labels` | `fetch` (openFDA, the only network step) writes `<records>/labels/<drug>.json`; `check` lists missing entries |
| `test_cards.py`, `test_labels.py`, `golden/` | synthetic records, golden rendered cards, an openFDA stub |

```sh
python3 -I tools/kb/build --records <records-dir>
python3 -I tools/symptom/labels fetch --records <records-dir>     # after a medicine ingest; commit labels/
python3 -I tools/symptom/labels check --records <records-dir>     # exit 1 when a current medicine has no entry
python3 -I tools/site/build --records <records-dir> --out <dir>   # renders the cards (reads only the cache)
python3 -I tools/symptom/test_cards.py && python3 -I tools/symptom/test_labels.py   # UPDATE_GOLDEN=1 after review
```

Records overrides: `config/symptom-card.json` (`sites`, `rules`, `modifiers`, `sources` replace or add by id;
`disable` rule ids; `status`), validated on every build (fail closed). Tier wording comes from
`docs/health/family/context.md` (`- **Tier A, <label>:** ...` bullets); generic defaults without it.

The card's "Send these questions to my DM" button posts to `tools/site/dx-api` (`POST /ask/<ns>`, allow-listed
tailnet login, word list, 20 per 24 h); `tools/dx/run` sends the queued text to the admin's private chat on its next
timer start (ADR 011: never a group).
