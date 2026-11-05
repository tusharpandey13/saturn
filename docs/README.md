# Saturn docs

Saturn (working name) is a home health log: household members send readings, photos, voice notes and documents to a Telegram group; a small Worker stores them, a daily batch extracts structured facts into a git-based knowledge base, and a daily digest goes to the admin by private DM; the group is input-only (ADR 011). It records and flags only; it never gives medical advice.

This repo is the **product**: code, schema, templates, generic runbooks and synthetic fixtures. A deployment also needs an **env repo** (`<env-repo>`: concrete config, SOPS secrets, run history) and a **records repo** (`<records-repo>`: all health data). See [ADR 008](decisions/008-product-environment-pii.md).

| You want… | Go to |
|---|---|
| How the bot, batch and knowledge base are built and tested | [platform/](platform/README.md) |
| How to deploy one environment | [platform/deploy.md](platform/deploy.md) |
| The threat model and credential scoping | [security.md](security.md) |
| How to keep a records repo (rules for agents and humans) | [records-guide.md](records-guide.md) |
| Why it is built this way | [decisions/](decisions/README.md) |
| How agents cross-reference records with the literature | [methods/research-crossref.md](methods/research-crossref.md) |
| How agents reason on open, unexplained problems (diagnostic loop, proposed) | [methods/diagnostic-loop.md](methods/diagnostic-loop.md) |
| How a loop run is started from the site without a session (T-01) | [methods/diagnostic-loop-trigger.md](methods/diagnostic-loop-trigger.md), [tools/dx/README.md](../tools/dx/README.md) |
| The research behind the decisions | [research/](research/README.md) |
| Page templates and doc governance | [meta/](meta/README.md) |
| What runs where in an environment (service catalog format, llms.txt, Gatus checks) | [catalog.md](catalog.md) |
| Deployment-specific notes (hosts, accounts, costs, token inventory) | the environment repo, not the product |

## Picking up the work
1. Read [records-guide.md](records-guide.md) for the standing rules (record and flag only, the go-live gate, no secrets, ids, provenance).
2. Read the [HLD](platform/hld.md) and [ADR 008](decisions/008-product-environment-pii.md) for the shape of the system.
3. Run the product checks against the synthetic records in `fixtures/records-example/` (see [platform/deploy.md](platform/deploy.md), step 1).
4. The current state of a deployment, its open to-dos and its history live in that deployment's env repo and records repo, never here.

TODO before the public flip: trademark check for the eventual public name (Saturn is a working name).
