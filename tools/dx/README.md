# tools/dx: "Run the loop" (T-01)

One bounded, unattended run of the [diagnostic loop](../../docs/methods/diagnostic-loop.md) (ADR 013), started by a
button on the tailnet health site, run by a host timer on the home server, with the result on the site and in the
admin's private DM. Implements ADR 013 §7 "later" without a Claude Code session
([method note](../../docs/methods/diagnostic-loop-trigger.md); origin: the 05-Nov-2026 usability review, U-04/T-01).

| Part | What |
|---|---|
| `tools/site/build --dx-api URL` | the overview's "Run the loop (delta)" form and "Status of the last run" link |
| `tools/site/dx-api` | tailnet endpoint: `POST /dx/<ns>/run` queues, `GET /dx/<ns>/status` reports; never runs the agent |
| `tools/dx/dxstate.py` | the shared state file, spool and caps (one flock) |
| `tools/dx/run` | the job: evidence pack, prompt, `claude -p`, verifier, commit, push, DM; `--dry-run` calls nothing |
| env repo `hosts/vivobook/saturn-dx.nix` | user `saturn-dx`, own records clone and signing key, timer every 2 min, endpoint on the Tailscale IP |

## Owner defaults (change them in the env module's flags)

| Setting | Default | Where |
|---|---|---|
| Who may press | the owner's tailnet login (`--allow`, from the `Tailscale-User-Login` header; a form value never counts) | dx-api |
| Run kind | DELTA run of the run prompt, single panel, hard cap 2 rounds, no ensemble | run (prompt) |
| Caps | 1 accepted request per 24 h, 8 per 30 days, counted over every accepted request (done, failed or queued), all namespaces together (`--cap-24h`, `--cap-30d`, `--cap-scope global\|ns`) | dx-api, state file |
| Wall clock | 3 h (`--wall-clock-s 10800`); the run is killed after it and whatever it wrote is verified | run |
| Budget | `--max-budget-usd 12` per run (`--budget-usd`); ADR 013 §8 budget | run |
| Model auth | the box's `CLAUDE_CODE_OAUTH_TOKEN` for Saturn PHI jobs (env repo `secrets/vivobook-hl.sops.env`, split to `/run/agent-creds/hl/claude.env`); no new token | nix `--claude-env` |
| DM | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ADMIN_CHAT_ID` from `secrets/vivobook-ops.sops.env`; a group (negative) chat id is refused | nix `--notify-env` |
| Tools | `--restricted --permission-mode dontAsk`; allowed: Read, Grep, Glob, Edit, Write, Agent, `Bash(python3 -I *)`, `Bash(git diff\|status\|log *)`, `Bash(gitleaks *)`, `WebFetch(domain:…)` on the method's literature hosts only (PubMed, E-utilities, PMC, Europe PMC, doi.org, DailyMed, openFDA, arXiv); WebSearch disallowed; file tools confined to the records clone and the product checkout | run |
| Writes | `docs/log/analysis/`, `inferences/<ns>/`, `docs/health/<ns>/{summary,questions}.md`, `docs/health/*/status.md` (tool-generated), `docs/health/family/actions.md`; anything else fails the run, nothing is committed, the outputs are stashed | run (verifier) |
| Commit | `docs: <ns> dx loop NN (delta, site trigger) [skip ci]` by "saturn dx-loop", SSH-signed with the job's own key (clone config); pushed to origin main | run |
| Awaiting key | until the owner registers the job's deploy key, the timer writes `<state>/awaiting-key`, the endpoint answers 503 and a push refusal keeps the commit local (state `awaiting-key`) | nix, dx-api, run |

The claude CLI (2.1.x) cannot restrict WebFetch to a per-prompt allow-list, so the job uses permission rules instead:
`--allowedTools WebFetch(domain:<host>)` per host, `--disallowedTools WebSearch`, in `dontAsk` mode (anything not
allowed is denied, never prompted). Subagents spawned by the orchestrator inherit the same rules.

## Verifier (before any commit)

Changed paths within the list above; the run note exists with "Facts as written; not advice; doctors decide."; no
medicine-change advice or verdict in the agent's voice on any added line (`ADVICE_RE`: "you should", "safe to",
"rules out", "confirms", "caused by", "nothing to worry about", and stop/start/reduce/increase/switch/taper/… near
dose/tablet/medicine/mg; question lines, quotes and the standing disclaimer are exempt; past tense records an event
and is not flagged); `tools/kb/build`, `gen-views --check`, `test_gen.py`, `tools/inference gen --check`; gitleaks on
every changed file. A hit fails the run: the state row carries the reason, the outputs go to `git stash` (named after
the run id) and the DM says "failed".

## By hand

```sh
python3 -I tools/dx/run --records R --product P --state S --ns <ns> --dry-run     # prompt + pack + validators, no call
python3 -I tools/dx/run --records R --product P --state S                          # take the oldest spool request
python3 -I tools/site/dx-api --records R --state S --bind 127.0.0.1 --port 8092 --site http://localhost/health
python3 -I tools/dx/test_dx.py && python3 -I tools/site/test_dx_api.py             # synthetic fixture only
```

Everything under `<state>/runs/<id>/` (prompt, pack, claude output, DM text) is PHI and stays on the box.
