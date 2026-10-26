# 002 — Medical media outside git

Date: 2026-10-24 · Status: superseded by 003

## Context
Raw videos, page images and scans of medical records are large and contain PHI. The repo is private but its history is hard to clean of PHI once committed.

## Decision
- Raw videos, page images and scans live in `<media-dir>` (not in git) and are backed up privately.
- Git holds only extracted text, indexes and manifests.

## Why
- Repo bloat: video and image files would grow the repository quickly.
- A git history can't be cleaned of PHI easily once committed.

## Reversal
Git LFS or Cloudflare R2 later, if needed.
