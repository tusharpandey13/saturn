# Saturn agent tasks (task pack for agent-server)

The `hl.*` and `saturn.*` tasks that agent-server runs for Saturn. They moved here from agent-server at the split, so the
generic job service has no domain tasks. The pack is versioned with Saturn. An agent-server environment loads it at
the Saturn version pinned in its `product.lock`, by adding a checkout of this directory to `TASK_DIRS`.

- Format: agent-server `schema/task.schema.json`. Check it with
  `TASK_SCHEMA_DIRS=<this dir> npm test` in an agent-server checkout.
- Every task is `min_class: phi`, refs-only params (queue ids, paths, sha256; no file contents, no names), claude-tier
  only, and `outputs: [git_pr]`.
- `saturn.research_crossref` ([method](../docs/methods/research-crossref.md)): deep tier (claude, opus), params
  `ns` + optional `focus`/`previous`/`reason`. It writes `docs/health/<ns>/research/YYYY-MM-DD-crossref.md`, its JSON
  sidecar ([output schema](saturn.research_crossref.output.schema.json)) and new `questions.md` rows. The sidecar must
  pass `tools/research/verify_citations.py`.
- **PR target = the records repo, set by the environment, not here.** A client submits
  `output: {type: git_pr, repo: <records repo>}`, and the router accepts it only if the repo is in the client token's
  `repos` allowlist (`clients.yaml` in the env repo). No repo name, person name or path to real records appears in this pack.
- Phase 1: `git_pr` delivery is not built in agent-server yet, so a submitted job fails as a contract error. The prompts
  are placeholders until phase 2.
