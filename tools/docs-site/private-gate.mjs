// Sharing gate (research method 4a, "Never shared"): private research outputs never reach a shared artefact.
// assertShareable(file, text) throws, fail-closed, when the path contains /research/private/ or the content is marked
// visibility: private (Markdown front matter, or a "visibility" JSON key anywhere in a .json file).
export const PRIVATE_DIR = '/research/private/';

export function privateReason(file, text) {
  const p = String(file).replace(/\\/g, '/');
  if (p.includes(PRIVATE_DIR)) return `path contains ${PRIVATE_DIR}`;
  if (/\.json$/i.test(p)) {
    if (/"visibility"\s*:\s*"private"/.test(text)) return 'JSON key "visibility": "private"';
  } else {
    const fm = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
    if (fm && /^visibility:\s*["']?private["']?\s*(#.*)?$/m.test(fm[1])) return 'front matter visibility: private';
  }
  return null;
}

export function assertShareable(file, text) {
  const why = privateReason(file, text);
  if (why) throw new Error(`sharing gate: refusing private input ${file} (${why}); private research is never shared`);
}
