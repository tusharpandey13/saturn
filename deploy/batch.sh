#!/usr/bin/env bash
# Daily batch (ADR 005), one step per call so the caller can scope secrets per step:
#   deploy/batch.sh pull    --records DIR                 D1 inbox + media -> records (raw first), commit + push
#   deploy/batch.sh extract --records DIR [--retry-failed]  STT + LLM extraction -> KB build -> generated pages, commit
#   deploy/batch.sh finish  --records DIR [--no-digest]   mark inbox rows done, assert the webhook, send the digest
# Env per step: see app/batch/run.ts and env.manifest.yaml (secrets). Exit codes: extract 3 = extraction delayed
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

case "$step" in
  pull)
    run pull ${extra[@]+"${extra[@]}"}
    commit "data: telegram raw $(stamp)" data/telegram sources ;;
  extract)
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
