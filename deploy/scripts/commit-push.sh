#!/usr/bin/env bash
# Commit the given paths in the TARGET repo (if anything changed) and push, rebasing on concurrent pushes.
#   commit-push.sh <repo-dir> "<message>" <path>...      (paths relative to <repo-dir>)
# Used by deploy/batch.sh to commit to the records repo. Author: $COMMIT_AUTHOR_NAME / $COMMIT_AUTHOR_EMAIL
# (defaults: "<product slug>-batch" and the GitHub Actions bot address). Branch: $TARGET_BRANCH (default main).
set -euo pipefail
repo="$1"; msg="$2"; shift 2
slug=$(sed -n 's/.*"slug": *"\([^"]*\)".*/\1/p' "$(dirname "$0")/../../product.json")
name="${COMMIT_AUTHOR_NAME:-${slug}-batch}"
email="${COMMIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
branch="${TARGET_BRANCH:-main}"
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
