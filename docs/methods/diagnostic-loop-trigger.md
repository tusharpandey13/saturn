---
title: "Diagnostic loop: the site trigger (T-01) implements ADR 013 §7 'later'"
audience: maintainer, agent
type: how-to
owner: maintainer
last_reviewed: 2026-11-05
review_every: 90d
status: proposed
sources: [docs/decisions/013-diagnostic-loop.md, docs/methods/diagnostic-loop-run-prompt.md, tools/dx/README.md]
generated: false
---

# Diagnostic loop: run from the site, not from a session

ADR 013 §7 said runs happen "now" in the owner's Claude Code session and "later" as a task on the egress-locked PHI
user. T-01 of the 05-Nov-2026 usability review is that "later", built small: a button on the person's overview queues
one request; a host timer runs [`tools/dx/run`](../../tools/dx/README.md) in the job's own records clone; the run note
lands in `docs/log/analysis/`, the status page refreshes through the normal site rebuild, and the admin gets one
10-line DM.

What stays exactly as the method says: the [run prompt](diagnostic-loop-run-prompt.md) is used verbatim (RUN = delta,
NS and PRODUCT filled in), the records `AGENTS.md` mode line is checked first, medicine advice is forbidden by the
prompt and refused by a post-check, literature access is limited to the method's hosts, and nothing leaves the
records repo.

What changes for an unattended run (the "HEADLESS RUN" block the job appends): no questions back to the owner; hard
cap 2 rounds, no ensemble; a prepared evidence pack; a fixed write set (no briefs: the note names the specialty that
needs a packet); step 9's "show me" becomes section 10 of the run note; the job, not the agent, commits and pushes.

Caps and budget are the owner's (1 run per 24 h, 8 per 30 days, 3 h, 12 USD per run); they sit in the env module and
`tools/dx/README.md`. The owner's session runs remain possible and are counted separately.
