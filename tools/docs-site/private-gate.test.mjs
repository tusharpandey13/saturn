// node --test tools/docs-site   (synthetic inputs only)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertShareable, privateReason } from './private-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

test('private paths are refused', () => {
  for (const f of ['/r/docs/health/zed/research/private/2026-10-27-crossref.md',
    'docs/health/zed/research/private/x.json', 'C:\\r\\research\\private\\x.md'])
    assert.throws(() => assertShareable(f, '# x\n'), /sharing gate: refusing private input/, f);
});

test('visibility: private in front matter or a JSON key is refused', () => {
  assert.match(privateReason('/r/a.md', '---\ntitle: x\nvisibility: private\n---\n# x\n'), /front matter/);
  assert.match(privateReason('/r/a.md', '---\r\nvisibility: "private"\r\n---\r\n'), /front matter/);
  assert.match(privateReason('/r/a.json', '{"schema": "x", "visibility" : "private"}'), /JSON key/);
  assert.match(privateReason('/r/a.json', '{"items": [{"visibility": "private"}]}'), /JSON key/);
});

test('public inputs pass', () => {
  for (const [f, t] of [['/r/docs/research/a.md', '---\nvisibility: public\n---\n# x\n'],
    ['/r/docs/research/b.md', '# Method\n\nA private file sets `visibility: private` in front matter.\n'],
    ['/r/docs/research/c.json', '{"visibility": "public"}'], ['/r/docs/research/privateish/d.md', '# d\n']])
    assert.equal(privateReason(f, t), null, f);
});

test('docs-site build fails closed on a private input', () => {
  // throwaway copy of the product with one private research page added; the real tree is not touched
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-gate-'));
  try {
    execFileSync('/usr/bin/git', ['-C', REPO, 'worktree', 'add', '--detach', '-q', path.join(tmp, 'p'), 'HEAD']);
    const p = path.join(tmp, 'p');
    fs.symlinkSync(path.join(HERE, 'node_modules'), path.join(p, 'tools/docs-site/node_modules'));
    for (const f of ['build.mjs', 'private-gate.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(p, 'tools/docs-site', f));
    fs.writeFileSync(path.join(p, 'docs/research/zz-private.md'), '---\nvisibility: private\n---\n# Synthetic\n');
    const r = spawnSync(process.execPath, [path.join(p, 'tools/docs-site/build.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /sharing gate: refusing private input .*zz-private\.md \(front matter visibility: private\)/);
    assert.equal(fs.existsSync(path.join(p, 'site/dist')), false);
  } finally {
    spawnSync('/usr/bin/git', ['-C', REPO, 'worktree', 'remove', '--force', path.join(tmp, 'p')]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('doctor-brief task refuses private research paths', () => {
  // no brief builder exists yet (hl.doctor_brief is a phase-2 stub): the gate is its params schema and prompt
  const y = fs.readFileSync(path.join(REPO, 'agent-tasks/hl.doctor_brief.yaml'), 'utf8');
  const m = y.match(/paths:.*not: \{ pattern: "([^"]+)" \}/);
  assert.ok(m, 'paths items carry a not-pattern');
  const re = new RegExp(m[1]);
  for (const s of ['docs/health/zed/research/private/2026-10-27-crossref.md', 'research/private/x.json'])
    assert.ok(re.test(s), s);
  for (const s of ['docs/health/zed/research/2026-10-27-crossref.md', 'docs/health/zed/summary.md'])
    assert.ok(!re.test(s), s);
  assert.match(y, /refuse, and stop with an error, if any input path contains \/research\/private\//);
});
