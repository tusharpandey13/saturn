#!/usr/bin/env bash
# Commit the given paths in the TARGET repo (if anything changed) and push, rebasing on concurrent pushes.
#   commit-push.sh <repo-dir> "<message>" <path>...      (paths relative to <repo-dir>)
# Used by deploy/batch.sh to commit to the records repo. Author: $COMMIT_AUTHOR_NAME / $COMMIT_AUTHOR_EMAIL
# (defaults: "<product slug>-batch" and the GitHub Actions bot address). Branch: $TARGET_BRANCH (default main).
# Push auth: $RECORDS_TOKEN (a short-lived App token; the checkout keeps no credential), passed to git through
# GIT_CONFIG_* env only (never argv, never .git/config). Signing: $BATCH_SIGNING_KEY (an SSH private key) -> a 0600 temp
# file, `gpg.format ssh`; every commit, including the ones a rebase re-creates, is signed. REQUIRE_SIGNED=1 (the env
# workflow) refuses to commit without a key.
set -euo pipefail
repo="$1"; msg="$2"; shift 2
slug=$(sed -n 's/.*"slug": *"\([^"]*\)".*/\1/p' "$(dirname "$0")/../../product.json")
name="${COMMIT_AUTHOR_NAME:-${slug}-batch}"
email="${COMMIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
branch="${TARGET_BRANCH:-main}"
cfg=()
if [ -n "${RECORDS_TOKEN:-}" ]; then
  cfg+=("http.https://github.com/.extraheader" "AUTHORIZATION: basic $(printf 'x-access-token:%s' "$RECORDS_TOKEN" | base64 | tr -d '\n')")
fi
if [ -n "${BATCH_SIGNING_KEY:-}" ]; then
  keyfile="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/batch-sign.XXXXXX")"
  trap 'rm -f "$keyfile"' EXIT
  chmod 600 "$keyfile"; printf '%s\n' "$BATCH_SIGNING_KEY" > "$keyfile"
  cfg+=("gpg.format" "ssh" "user.signingkey" "$keyfile" "commit.gpgsign" "true")
elif [ "${REQUIRE_SIGNED:-}" = 1 ]; then
  echo "commit-push: REQUIRE_SIGNED=1 but no BATCH_SIGNING_KEY; nothing committed" >&2; exit 1
fi
export GIT_CONFIG_COUNT=$(( ${#cfg[@]} / 2 ))
for ((i = 0; i < ${#cfg[@]}; i += 2)); do export "GIT_CONFIG_KEY_$((i / 2))=${cfg[i]}" "GIT_CONFIG_VALUE_$((i / 2))=${cfg[i + 1]}"; done
cd "$repo"
for p in "$@"; do
  # globs that matched nothing stay literal; skip paths that do not exist
  if [ -e "$p" ]; then git add -A -- "$p"; fi
done
if git diff --cached --quiet; then echo "no changes"; exit 0; fi
git -c user.name="$name" -c user.email="$email" commit -q -m "$msg"
for i in 1 2 3; do
  if git pull -q --rebase origin "$branch" && git push -q origin "HEAD:$branch"; then exit 0; fi
  sleep $((i * 10))
done
echo "push failed after 3 attempts" >&2
exit 1
