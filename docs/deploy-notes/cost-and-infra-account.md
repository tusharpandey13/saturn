# Deploy notes: cost and infra, account specifics

Source: §4 of the original cost and infra research (2026-10-25); the generic part stays in [research/cost-and-infra-2026-10.md](../research/cost-and-infra-2026-10.md). **Route to the env repo at S7, then delete from the product.** Values: see env repo (and the original research note in the source repo). No secrets, no PHI here.

## What must be routed (placeholders only)
| Item | What it records | Placeholder |
|---|---|---|
| Where the agent-server plan was found | a past Claude Code session of the operator and its local transcript path; a separate Mac-local notes file for a different setup | `<home>/…` (values: see env repo) |
| Operator's current agent setup | which Claude plan tier the operator holds (an env choice), the other agents and providers in use, the laptop model, remote access (Paseo, Tailscale + SSH) and that the laptop was kept awake for a trip | values: see env repo |
| GitHub org that is the source of truth | the private org name | `<org>` |
| Cost actually paid / plan tiers | the flat-rate LLM plan the deep reads and scheduled agents run on ("$0 marginal") | values: see env repo |
| Media folder size | the size of the PHI media folder kept off the VPS | `<media-dir>` (size: see env repo) |
| Concrete Cloudflare resources costed in §1 | worker, D1, bucket and queue names | `<worker>`, `<d1-name>`, `<bucket>`, `<queue>` |
