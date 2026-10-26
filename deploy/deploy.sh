#!/usr/bin/env bash
# Deploy the ingest Worker (ADR 005) for one environment:
#   deploy/deploy.sh --env <env.yaml>
# 1. checks env.yaml against env.manifest.yaml; 2. renders app/wrangler.toml from deploy/wrangler.template.toml;
# 3. wrangler deploy (auto-provisions D1 and R2 on the first run when env.yaml pins no D1 id: pin it afterwards);
# 4. applies app/migrations to the remote D1; 5. pushes the Worker secrets that are set; 6. smoke-tests WORKER_URL.
# Env: CLOUDFLARE_API_TOKEN (or CLOUDFLARE_DEPLOY_TOKEN, the manifest name), CLOUDFLARE_ACCOUNT_ID (required); TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
# WORKER_URL (optional). Install deps beforehand without secrets: (cd app && npm ci --ignore-scripts).
set -euo pipefail
PRODUCT="$(cd "$(dirname "$0")/.." && pwd)"
[ "${1:-}" = "--env" ] && [ -n "${2:-}" ] || { echo "usage: deploy.sh --env <env.yaml>" >&2; exit 2; }
envfile="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_DEPLOY_TOKEN:-}}"
: "${CLOUDFLARE_API_TOKEN:?not set}" "${CLOUDFLARE_ACCOUNT_ID:?not set}"
cd "$PRODUCT/app"
npx tsx scripts/render.ts check --env "$envfile"
npx tsx scripts/render.ts wrangler --env "$envfile"
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
node -e '
  const o = {}; for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]) if (process.env[k]) o[k] = process.env[k];
  process.stdout.write(JSON.stringify(o));' | npx wrangler secret bulk > /dev/null
if [ -n "${WORKER_URL:-}" ]; then curl -fsS --retry 3 "${WORKER_URL}/health" > /dev/null && echo "smoke: /health ok"; fi
