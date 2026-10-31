#!/usr/bin/env bash
# One run of the Mac STT runner (a launchd user agent calls this every ~10 min while the Mac is awake).
#   tools/stt/mac-run.sh --records DIR
# Steps: pause file? -> lock -> battery >= 20% (or on AC) -> git pull --rebase -> tools/stt/stt run -> commit only the
# files the run wrote (signed by the user's git config) -> git pull --rebase -> push. Never touches other files; a
# dirty tree outside our outputs, a rebase conflict or a failed push stops the run (next run retries).
# Env: SATURN_STT_CACHE (engines), SATURN_STT_LOG (default ~/Library/Logs/saturn-stt/runner.log),
#      SATURN_STT_PAUSE (default ~/.config/saturn/stt.pause: if it exists, the run exits at once).
# Logs carry file ids, counts and timings only.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
records=""
while [ $# -gt 0 ]; do case "$1" in --records) records="$2"; shift 2 ;; *) echo "usage: mac-run.sh --records DIR" >&2; exit 3 ;; esac; done
[ -n "$records" ] && [ -d "$records/.git" ] || { echo "mac-run: --records must be a git clone" >&2; exit 3; }
log="${SATURN_STT_LOG:-$HOME/Library/Logs/saturn-stt/runner.log}"
pause="${SATURN_STT_PAUSE:-$HOME/.config/saturn/stt.pause}"
cache="${SATURN_STT_CACHE:-$HOME/Library/Caches/saturn-stt}"
mkdir -p "$(dirname "$log")" "$cache"
exec >>"$log" 2>&1
say() { echo "$(date '+%Y-%m-%dT%H:%M:%S') mac-run: $*"; }

[ -e "$pause" ] && { say "paused ($pause exists)"; exit 0; }

lock="$cache/run.lock"
if ! mkdir "$lock" 2>/dev/null; then
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then say "another run is active (pid $pid)"; exit 0; fi
  say "stale lock removed"; rm -rf "$lock"; mkdir "$lock" || exit 1
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT

batt="$(pmset -g batt 2>/dev/null || true)"
if echo "$batt" | grep -q "Battery Power"; then
  pct="$(echo "$batt" | grep -Eo '[0-9]+%' | head -1 | tr -d %)"
  if [ -n "$pct" ] && [ "$pct" -lt 20 ]; then say "on battery at ${pct}%: skipped"; exit 0; fi
fi

cd "$records" || exit 1
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then say "records clone has uncommitted changes: skipped"; exit 0; fi
git pull -q --rebase origin main || { git rebase --abort 2>/dev/null; say "pull failed: skipped"; exit 1; }

written="$(mktemp)"; trap 'rm -rf "$lock" "$written"' EXIT
python3 -I "$here/stt" run --records "$records" --written "$written" || say "stt run exited $?"
n=0
if [ -s "$written" ]; then
  n="$(grep -c 'mac.transcript.md$' "$written" || true)"
  while IFS= read -r f; do git add -- "$f"; done < "$written"
fi
if ! git diff --cached --quiet; then
  ssh-add --apple-load-keychain -q 2>/dev/null || true   # the signing key's passphrase lives in the login keychain
  git commit -q -m "data: mac machine transcripts ($n audio), answer proposals, STT eval [skip ci]" || { say "commit failed (signing?)"; git reset -q; exit 1; }
fi
[ "$(git rev-list --count origin/main..HEAD)" -gt 0 ] || { say "nothing new"; exit 0; }
for i in 1 2; do
  if git pull -q --rebase origin main && git push -q origin HEAD:main; then say "pushed $(git rev-parse --short HEAD) ($n new transcript(s))"; exit 0; fi
  git rebase --abort 2>/dev/null; sleep 5
done
say "push failed: the commit stays local; the next run retries"
exit 1
