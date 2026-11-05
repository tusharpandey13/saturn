# AGENTS.md: rules for agents and humans working on the Saturn product

1. **No PHI, no secrets, no environment values in this repo.** Synthetic data only (`fixtures/`). Names, resource ids,
   hostnames, org names and accounts are env parameters (`env.manifest.yaml`); people and namespaces come from a
   records repo's `records.yaml`.
2. **Record and flag only.** Nothing in code, prompts or docs diagnoses or suggests a medication change.
3. Records-side rules (ids, provenance, superseding, ingest fan-out) are in [docs/records-guide.md](docs/records-guide.md).
4. Before committing: `pre-commit run --all-files`, the app tests (`cd app && npm test && npm run typecheck &&
   npm run e2e:local`) and the KB tests (`python3 -I tools/kb/test_build.py && python3 -I tools/kb/test_gen.py`), plus
   `python3 -I tools/research/test_verify_citations.py`, `python3 -I tools/catalog/test_catalog.py`, `python3 -I tools/search/test_search.py`, `python3 -I tools/fitness/test_fitness.py` and `python3 -I tools/stt/test_stt.py`.
6. Research cross-references follow [docs/methods/research-crossref.md](docs/methods/research-crossref.md).
5. Decisions go in `docs/decisions/NNN-*.md` (MADR). Deployment notes go to the env repo, not here.
