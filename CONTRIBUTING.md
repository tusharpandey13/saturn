# Contributing to Saturn

Thanks for helping. Saturn handles health data, so a few rules are stricter than usual.

## Synthetic data only
- Never put real health data, names, phone numbers, chat ids, photos or documents in an issue, PR, test or fixture.
  Use the synthetic records in `fixtures/records-example/` and the generators in `tools/doc-scan/tests/`.
- Binary files belong under `fixtures/` only (the gate rejects them elsewhere).
- No deployment values (account ids, resource ids, hostnames, org names) in the product: they are env parameters
  (`env.manifest.yaml`).

## Record and flag, never advise
Code and prompts must never diagnose or suggest a medication change. Alerts phrase concerns as questions for a doctor.

## Workflow
1. Fork, branch, and keep the change small.
2. Run the gate and the tests:
   ```sh
   pre-commit run --all-files
   (cd app && npm ci --ignore-scripts && npm test && npm run typecheck && npm run e2e:local)
   python3 -I tools/kb/test_build.py && python3 -I tools/kb/test_gen.py
   ```
3. Sign off every commit (Developer Certificate of Origin, https://developercertificate.org): `git commit -s`.
   There is no CLA.
4. Open a PR. CI runs the same gate with no secrets.

## Dependencies
Dependabot proposes updates after a 7-day cooldown. GitHub Actions and pre-commit hooks are pinned by commit SHA.
Install with frozen lockfiles and `--ignore-scripts`.
