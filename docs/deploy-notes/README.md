# deploy-notes/

Deployment-specific content moved out of the product docs during the split. Every file here is **routed to the env repo (`<env-repo>`) at S7, then deleted from the product.** The files list WHAT must be routed, with placeholders; the values already live in the source repo and the env (values: see env repo). No PHI, no secrets.

| File | From | Route to (env repo) |
|---|---|---|
| [deploy-runbook-values.md](deploy-runbook-values.md) | old deploy runbook: concrete values, run ids, state and open items at the split | `runbooks/deploy.md` |
| [auth-review-incidents.md](auth-review-incidents.md) | old auth review: incidents, per-hop gaps, executed rotation runbook, final token set | `security/auth-review.md` |
| [token-inventory.md](token-inventory.md) | token architecture §1 and §7 values (inventory) | `security/token-inventory.md` |
| [cost-and-infra-account.md](cost-and-infra-account.md) | cost and infra research: account plans and specifics | `ops/cost-and-account.md` |
| [handoff.md](handoff.md) | old handoff: state pointers | `README.md` (handoff section) |

Route to env repo at S7, then delete from product.
