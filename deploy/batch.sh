#!/usr/bin/env bash
# Daily batch (ADR 005), one step per call so the caller can scope secrets per step:
#   deploy/batch.sh pull    --records DIR                 D1 inbox + media -> records (raw first); no commit
#   deploy/batch.sh extract --records DIR [--retry-failed]  local STT (whisper.cpp) + LLM extraction -> KB build ->
#                                                         generated pages -> cross-check flags (digest section); no commit.
#                                                         THE AI STEP: refuses to run if any write credential is visible
#                                                         (assert-isolated); `claude -p` gets an allowlisted env, no tools.
#   deploy/batch.sh commit raw|batch|digest --records DIR  deterministic: fails unless every change in the records
#                                                         checkout is under the batch paths; signs (SSH key) and pushes.
#                                                         Needs RECORDS_TOKEN (push) and BATCH_SIGNING_KEY (signing).
#   deploy/batch.sh finish  --records DIR [--no-digest] [--force-digest]
#                                                         mark inbox rows done, assert the webhook, DM the digest to
#                                                         the admins (once per IST day); no commit (then: commit digest)
#   deploy/batch.sh assert-isolated --records DIR         the AI-step check alone (exit 1 + the variable NAMES found)
# The bot never posts to a group (ADR 011). The admin digest goes out only after a fully successful run: pull and
# extract delete the digest file first, and extract leaves it only when extraction, KB build, gen-views and the commit
# all succeeded. Otherwise finish sends the short ops DM only.
# Batch paths (the only paths a batch commit may touch; the env's records-integrity check enforces the same list):
#   data/telegram/**, data/queue/**, sources/<ns>/media/telegram/**, docs/health/**, crossref/**, inferences/**
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
export DIGEST_FILE="${DIGEST_FILE:-${RUNNER_TEMP:-$PRODUCT/app/.batch}/digest.txt}"
run() { (cd "$PRODUCT/app" && npx tsx batch/run.ts "$@" --records "$records"); }
commit() { "$PRODUCT/deploy/scripts/commit-push.sh" "$records" "$@"; }
# Variables that must never be visible to the AI step (model auth CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY is the
# only credential it gets). Any other name ENDING in TOKEN, _KEY, SECRET, PASSWORD, PRIVATE_KEY, CREDENTIAL(S) or _PAT
# also fails the check (names like SECRETS_EXTRACT, a list of SOPS file paths, or CLAUDE_TOKEN_CREATED, a date, do not).
FORBIDDEN="SOPS_AGE_KEY SOPS_AGE_KEY_FILE GITHUB_TOKEN GH_TOKEN RECORDS_TOKEN BATCH_SIGNING_KEY RECORDS_APP_PRIVATE_KEY
PRODUCT_DEPLOY_KEY ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL CLOUDFLARE_D1_TOKEN
CLOUDFLARE_R2_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_DEPLOY_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET GIT_CONFIG_PARAMETERS
GIT_ASKPASS SSH_AUTH_SOCK"
assert_isolated() {
  local bad=() v
  for v in $FORBIDDEN; do [ -z "${!v:-}" ] || bad+=("$v"); done
  while IFS= read -r v; do
    case "$v" in CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY) ;; *) bad+=("$v") ;; esac
  done < <(compgen -e | grep -E '(TOKEN|_KEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS?|_PAT)$' || true)
  for v in $(compgen -e | grep -E '^GIT_CONFIG_(KEY|VALUE)_' || true); do
    case "${!v}" in *extraheader*|*AUTHORIZATION*|*credential*|*signingkey*) bad+=("$v") ;; esac
  done
  # The records checkout must hold no credential either (actions/checkout persist-credentials: false).
  if git -C "$records" config --get-regexp '(extraheader|credential|signingkey)' >/dev/null 2>&1 \
     || grep -qiE 'authorization|x-access-token' "$records/.git/config" 2>/dev/null \
     || [ -s "${HOME:-/nonexistent}/.git-credentials" ]; then bad+=("records-git-credential"); fi
  if [ ${#bad[@]} -gt 0 ]; then
    echo "::error::batch.sh: write credentials visible to the AI step: $(printf '%s\n' "${bad[@]}" | sort -u | tr '\n' ' ')" >&2
    return 1
  fi
  echo "batch.sh: AI step isolated (no write token, App key, SOPS key or git credential visible)"
}
# The only paths a batch commit may contain (bash patterns; * crosses /).
allowed_path() {
  case "$1" in
    data/telegram/*|data/queue/*|docs/health/*|crossref/*|inferences/*) return 0 ;;
    sources/*) [[ "$1" =~ ^sources/[^/]+/media/telegram/[^/]+$ ]] ;;
    *) return 1 ;;
  esac
}
check_paths() {
  local bad=0 p
  while IFS= read -r -d '' p; do
    allowed_path "$p" || { echo "::error::batch.sh: change outside the batch paths: $p" >&2; bad=1; }
  done < <(git -C "$records" -c core.quotePath=false status --porcelain=v1 -z --untracked-files=all | tr '\0' '\n' | sed -E 's/^.. //; /^$/d' | tr '\n' '\0')
  return "$bad"
}
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
    rm -f "$DIGEST_FILE" "$DIGEST_FILE.ops"
    code=0; run pull ${extra[@]+"${extra[@]}"} || code=$?
    exit "$code" ;;
  assert-isolated)
    assert_isolated ;;
  commit)
    what="${extra[0]:-}"
    # A failed raw/batch commit also drops the digest: the admins get the ops DM, not a digest of unpushed data.
    check_paths || { echo "batch.sh: nothing committed (unexpected paths)" >&2; [ "$what" = digest ] || rm -f "$DIGEST_FILE"; exit 1; }
    case "$what" in
      raw) commit "data: telegram raw $(stamp)" data/telegram sources || { rm -f "$DIGEST_FILE"; exit 1; } ;;
      batch) commit "data: telegram batch $(stamp)" data/telegram data/queue docs/health crossref inferences sources || { rm -f "$DIGEST_FILE"; exit 1; } ;;
      digest) commit "data: digest log $(stamp)" data/telegram/digests.jsonl ;;
      *) echo "batch.sh: commit raw|batch|digest" >&2; exit 2 ;;
    esac ;;
  extract)
    rm -f "$DIGEST_FILE"; ok=0
    trap '[ "$ok" = 1 ] || rm -f "$DIGEST_FILE"' EXIT # any failure below: no digest
    assert_isolated
    ensure_claude
    code=0; run extract ${extra[@]+"${extra[@]}"} || code=$?
    if [ "$code" != 0 ] && [ "$code" != 3 ]; then exit "$code"; fi
    # The extracted rows are committed even when the KB build fails (as before the split); the job still fails.
    built=0; python3 -I "$PRODUCT/tools/kb/build" --records "$records" && python3 -I "$PRODUCT/tools/kb/gen-views" --records "$records" || built=$?
    # Cross-check (ADR 012, tools/crossref): after a good build; appends its section to the digest file when there is
    # one. It never blocks the digest or the commit; its log line is counts only.
    if [ "$built" = 0 ]; then
      python3 -I "$PRODUCT/tools/crossref/crossref" --records "$records" --digest "$DIGEST_FILE" \
        || echo "batch.sh: crossref failed; the digest goes out without its section" >&2
      # Status pages from agent-inferred records (tools/inference): page generation only, no AI; never blocks.
      python3 -I "$PRODUCT/tools/inference/inference" --records "$records" gen \
        || echo "batch.sh: inference gen failed; status pages not refreshed" >&2
    fi
    # Committed by the next workflow step (batch.sh commit batch), which has the push token and the signing key.
    if [ "$built" != 0 ]; then echo "batch.sh: KB build or gen-views failed; the extracted rows are still committed by the commit step" >&2; exit 1; fi
    if [ "$code" = 0 ]; then ok=1; fi
    exit "$code" ;;
  finish)
    code=0; run finish ${extra[@]+"${extra[@]}"} || code=$?
    exit "$code" ;;
  *) echo "batch.sh: unknown step $step" >&2; exit 2 ;;
esac
