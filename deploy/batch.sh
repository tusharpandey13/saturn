#!/usr/bin/env bash
# Daily batch (ADR 005), one step per call so the caller can scope secrets per step:
#   deploy/batch.sh pull    --records DIR                 D1 inbox + media -> records (raw first), commit + push
#   deploy/batch.sh extract --records DIR [--retry-failed]  STT + LLM extraction -> KB build -> generated pages, commit
#   deploy/batch.sh finish  --records DIR [--no-digest]   mark inbox rows done, assert the webhook, send the digest
# Env per step: see app/batch/run.ts and env.manifest.yaml (secrets). Exit codes: pull/finish 3 = Cloudflare delayed
# (429 after retries; rows stay new), extract 3 = extraction delayed
# (what was extracted is still built and committed). Output is counts only: no message content reaches the log.
set -euo pipefail
PRODUCT="$(cd "$(dirname "$0")/.." && pwd)"
step="${1:?usage: batch.sh pull|extract|finish --records DIR [flags]}"; shift
records=""; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --records) records="$(cd "$2" && pwd)"; shift 2 ;;
    *) extra+=("$1"); shift ;;
  esac
done
[ -n "$records" ] || { echo "batch.sh: --records DIR is required" >&2; exit 2; }
run() { (cd "$PRODUCT/app" && npx tsx batch/run.ts "$@" --records "$records"); }
commit() { "$PRODUCT/deploy/scripts/commit-push.sh" "$records" "$@"; }
stamp() { date -u +%Y-%m-%dT%H:%MZ; }
# `npm install -g --ignore-scripts @anthropic-ai/claude-code` leaves bin/claude.exe as a stub that only prints
# "claude native binary not installed" and exits 1 (its postinstall, install.cjs, links the platform binary from the
# optional dependency npm already installed). Run that one postinstall here; every other install script stays off.
ensure_claude() {
  local bin pkg
  bin="$(command -v "${CLAUDE_BIN:-claude}" 2>/dev/null)" || return 0
  grep -q "claude native binary not installed" "$bin" 2>/dev/null || return 0
  pkg="$(cd "$(dirname "$(readlink -f "$bin")")/.." && pwd)"
  [ -f "$pkg/install.cjs" ] || { echo "batch.sh: claude CLI is the npm stub and install.cjs is missing" >&2; return 0; }
  (cd "$pkg" && node install.cjs >/dev/null) && echo "batch.sh: claude CLI native binary linked (postinstall)" \
    || echo "batch.sh: claude CLI postinstall failed" >&2
}

case "$step" in
  pull)
    # Exit 3 = delayed (Cloudflare rate limit/outage): nothing was written or marked; no commit.
    code=0; run pull ${extra[@]+"${extra[@]}"} || code=$?
    if [ "$code" != 0 ]; then exit "$code"; fi
    commit "data: telegram raw $(stamp)" data/telegram sources ;;
  extract)
    ensure_claude
    code=0; run extract ${extra[@]+"${extra[@]}"} || code=$?
    if [ "$code" != 0 ] && [ "$code" != 3 ]; then exit "$code"; fi
    # The extracted rows are committed even when the KB build fails (as before the split); the job still fails.
    built=0; python3 -I "$PRODUCT/tools/kb/build" --records "$records" && python3 -I "$PRODUCT/tools/kb/gen-views" --records "$records" || built=$?
    commit "data: telegram batch $(stamp)" data/telegram data/queue docs/health
    if [ "$built" != 0 ]; then echo "batch.sh: KB build or gen-views failed; extracted rows are committed" >&2; exit 1; fi
    exit "$code" ;;
  finish)
    run finish ${extra[@]+"${extra[@]}"} ;;
  *) echo "batch.sh: unknown step $step" >&2; exit 2 ;;
esac
