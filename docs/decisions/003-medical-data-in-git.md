# 003 — Medical data in the private git repo

Date: 2026-10-24 · Status: accepted · Supersedes: 002

## Context
The user decided on 2026-10-24 to store the medical data (document photos, PDFs, extracted page images, chat media) in git/GitHub itself (today: the private records repo). This supersedes ADR 002, which kept raw media outside git.

## Decision
- Medical images and PDFs go under `sources/<person>/media/` and `sources/<person>/documents/` in the private records repo.
- Raw videos stay OUT of git. GitHub's hard limit is 100 MB per file and the repo soft limit is about 5 GB. Only the extracted page images and PDFs are committed.
- Keep each file under 50 MB. Downscale photos where needed.
- The repo must stay private.

## Risks
- PHI in git history is hard to purge once committed.
- The repo must stay private at all times.
- Repo growth: revisit when the repo passes about 2 GB.

## Reversal / next step
Consider git LFS or Cloudflare R2 if the repo passes about 2 GB.
