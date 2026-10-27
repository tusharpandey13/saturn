# docs-site: build and serving

Build: `cd tools/docs-site && npm ci && node build.mjs` writes `site/dist/` (gitignored) and `site/sanitisation-report.md`.
The build fails, and deletes `site/dist`, if the denylist gate matches anything (token prefixes, ids, the literal value of
any secret in the local env files under `~/.config/<app>/`, and whatever the sanitiser adds).
Before that, the sharing gate (`private-gate.mjs`) fails the build, writing nothing, if any input path contains
`/research/private/` or an input is marked `visibility: private` (front matter or JSON key). Tests: `npm test`.

Sanitiser: `node build.mjs --sanitiser <file>` loads an optional plugin with the deployment's own rules (names, doctors,
hospitals, drug names, ids). It lives in the records repo, never in the product; without it only the generic gate runs.

Generator: a ~200-line Node script on `markdown-it` (the only dependency, pinned); search is a JSON index plus a few lines of JS;
Mermaid loads from jsdelivr ESM only on pages that have diagrams. No framework, no theme, nothing else to patch.

`site/dist` is plain static files with relative links only, so it works from any subpath
(e.g. Tailscale `tailscale serve --set-path /docs site/dist`, served at `https://<host>.<tailnet>.ts.net/docs/`) or wrapped with StatiCrypt. It does not work from `file://`
(search uses `fetch`).

## Public hosting (deferred)
A Cloudflare Pages + Access (email one-time PIN) deploy was scoped and dropped as too complex for now. If revived: create the
Access self-hosted app for `<project>.pages.dev` and `*.<project>.pages.dev` **before** the first deploy, then verify unauthenticated
requests get a 302 to `<team>.cloudflareaccess.com` or a 403. Token: Account → Cloudflare Pages: Edit; Access: Apps and Policies: Edit;
Access: Organizations, Identity Providers, and Groups: Edit (only to create the One-time PIN IdP). References:
[Access apps API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/),
[Access policies API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/),
[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/),
[Pages projects API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/),
[securing *.pages.dev](https://developers.cloudflare.com/pages/platform/known-issues/).
