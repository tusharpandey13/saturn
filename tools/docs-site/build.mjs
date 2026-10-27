#!/usr/bin/env node
// Product docs static site: markdown -> (optional sanitiser) -> HTML -> (optional denylist gate).
// Every input first passes the sharing gate (private-gate.mjs): no /research/private/ path, no visibility: private.
// Usage: node tools/docs-site/build.mjs [--sanitiser <file.mjs>]   (env AGENT_SERVER_DIR: include its README/RUNBOOK)
// The product docs are PHI-free, so the default build has no sanitiser. A sanitiser plugin (kept privately, e.g. in a
// records repo) exports sanitise(key, text) -> { text, log }, checkPerFileKeys(keys), buildDenylist(repo) and
// scanDir(dir, denylist) -> [{ file, line, label }]; with it the build also runs the denylist gate.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { pathToFileURL } from 'node:url';
import { assertShareable } from './private-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(REPO, 'site/dist');
const AGENT = process.env.AGENT_SERVER_DIR || '';
const PRODUCT = JSON.parse(fs.readFileSync(path.join(REPO, 'product.json'), 'utf8')).name;
const SITE = `${PRODUCT} docs`;
const argi = process.argv.indexOf('--sanitiser');
const plugin = argi > 0 ? await import(pathToFileURL(path.resolve(process.argv[argi + 1])).href) : null;
const { sanitise, checkPerFileKeys, buildDenylist, scanDir } = plugin ?? {
  sanitise: (_key, text) => ({ text, log: [] }), checkPerFileKeys: () => {}, buildDenylist: () => [], scanDir: () => [],
};

// ---------------------------------------------------------------- sources
const PLATFORM = ['hld', 'hl-service-design', 'deploy', 'oss-review-hl-service', 'token-architecture', 'e2e-testing'];
const pages = [];
const addPage = (group, src, key) => {
  if (!fs.existsSync(src)) throw new Error(`missing source ${src}`);
  pages.push({ group, src, key, url: `${key}.html` });
};
for (const p of PLATFORM) addPage('Platform', path.join(REPO, 'docs/platform', `${p}.md`), `platform/${p}`);
addPage('Platform', path.join(REPO, 'docs/security.md'), 'platform/security');
addPage('Platform', path.join(REPO, 'docs/records-guide.md'), 'platform/records-guide');
for (const f of fs.readdirSync(path.join(REPO, 'docs/decisions')).filter((f) => /\.md$/.test(f)).sort())
  addPage('ADRs', path.join(REPO, 'docs/decisions', f), `adr/${f.replace(/\.md$/, '')}`);
for (const f of fs.readdirSync(path.join(REPO, 'docs/research')).filter((f) => /\.md$/.test(f) && f !== 'README.md').sort())
  addPage('Research', path.join(REPO, 'docs/research', f), `research/${f.replace(/\.md$/, '')}`);
if (AGENT) {
  addPage('agent-server', path.join(AGENT, 'README.md'), 'agent-server/readme');
  addPage('agent-server', path.join(AGENT, 'RUNBOOK.md'), 'agent-server/runbook');
}
// Sharing gate before anything is written: no private research input, whatever the sanitiser says.
try {
  for (const p of pages) assertShareable(path.resolve(p.src), fs.readFileSync(p.src, 'utf8'));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
checkPerFileKeys(pages.map((p) => p.key));
const bySrc = new Map(pages.map((p) => [path.resolve(p.src), p]));

// ---------------------------------------------------------------- build stamp
const git = (...a) => execFileSync('/usr/bin/git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const hlSha = git('rev-parse', '--short=10', 'HEAD') + (git('status', '--porcelain', '--', 'docs') ? '+dirty' : '');
function headOf(dir) {
  try {
    const gd = path.join(dir, '.git');
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 10);
    const ref = head.slice(5);
    const loose = path.join(gd, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 10);
    const packed = fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    return packed ? packed.slice(0, 10) : 'unknown';
  } catch { return 'unknown'; }
}
const agentSha = AGENT ? headOf(AGENT) : 'n/a';
const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------- markdown
const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

function renderer(page) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  // Mermaid fences -> <pre class="mermaid"> (rendered client-side)
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, i, opts, env, self) =>
    tokens[i].info.trim() === 'mermaid'
      ? `<pre class="mermaid">${escHtml(tokens[i].content)}</pre>\n`
      : fence(tokens, i, opts, env, self);
  // Heading ids
  const seen = new Map();
  md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
    const text = tokens[i + 1].children.map((t) => t.content).join('');
    let id = slugify(text) || 'section';
    const n = seen.get(id) || 0; seen.set(id, n + 1);
    if (n) id += `-${n}`;
    tokens[i].attrSet('id', id);
    return self.renderToken(tokens, i, opts);
  };
  // Links: rewrite links to included pages; unlink private relative paths.
  const dropped = [];
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const href = tokens[i].attrGet('href') || '';
    if (/^(https?:|mailto:|#)/.test(href)) {
      if (/^https?:/.test(href)) { tokens[i].attrSet('rel', 'noopener noreferrer'); }
      return self.renderToken(tokens, i, opts);
    }
    const [p, hash] = href.split('#');
    const target = bySrc.get(path.resolve(path.dirname(page.src), decodeURIComponent(p)));
    if (target) {
      tokens[i].attrSet('href', rel(page.url, target.url) + (hash ? `#${hash}` : ''));
      return self.renderToken(tokens, i, opts);
    }
    dropped.push(i);
    return '<span class="unlinked" title="not published">';
  };
  md.renderer.rules.link_close = (tokens, i, opts, env, self) => {
    // find matching open
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (tokens[j].type === 'link_close') depth++;
      if (tokens[j].type === 'link_open') { if (depth === 0) return dropped.includes(j) ? '</span>' : '</a>'; depth--; }
    }
    return '</a>';
  };
  return md;
}

const rel = (from, to) => path.posix.relative(path.posix.dirname(from), to) || path.posix.basename(to);

// ---------------------------------------------------------------- templates
const GROUPS = ['Platform', 'ADRs', 'Research', 'agent-server'];
function nav(cur) {
  return GROUPS.map((g) => `<h3>${g}</h3><ul>` + pages.filter((p) => p.group === g).map((p) =>
    `<li><a href="${rel(cur, p.url)}"${p.url === cur ? ' aria-current="page"' : ''}>${escHtml(p.title)}</a></li>`).join('') + '</ul>').join('');
}
function layout(cur, title, body) {
  const root = rel(cur, 'index.html').replace(/index\.html$/, '') || './';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escHtml(title)} · ${escHtml(SITE)}</title>
<link rel="stylesheet" href="${root}assets/style.css">
<script type="module" src="${root}assets/app.js"></script>
</head><body data-root="${root}">
<header class="top"><a class="brand" href="${root}index.html">${escHtml(SITE)}</a>
<input id="q" type="search" placeholder="Search…" aria-label="Search" autocomplete="off">
<button id="menu" aria-label="Menu" aria-expanded="false">☰</button></header>
<div id="results" hidden></div>
<div class="wrap"><nav id="nav">${nav(cur)}<h3>Site</h3><ul><li><a href="${rel(cur, 'sanitisation-report.html')}">Sanitisation report</a></li></ul></nav>
<main>${body}
<footer>Last built ${builtAt} · source commit ${escHtml(PRODUCT)} <code>${hlSha}</code>, agent-server <code>${agentSha}</code>${plugin ? ' · sanitised build' : ''}</footer>
</main></div></body></html>
`;
}

// ---------------------------------------------------------------- build
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.copyFileSync(path.join(HERE, 'assets/style.css'), path.join(OUT, 'assets/style.css'));
fs.copyFileSync(path.join(HERE, 'assets/app.js'), path.join(OUT, 'assets/app.js'));

const report = [];
for (const p of pages) {
  const raw = fs.readFileSync(p.src, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''); // drop YAML front matter
  const { text, log } = sanitise(p.key, raw);
  p.text = text;
  p.title = (text.match(/^#\s+(.+)$/m) || [, path.basename(p.src, '.md')])[1].replace(/[`*_]/g, '');
  if (p.group === 'agent-server') p.title = `agent-server ${path.basename(p.src, '.md')}`;
  report.push({ key: p.key, src: p.group === 'agent-server' ? `agent-server/${path.basename(p.src)}` : path.relative(REPO, p.src), log });
}
const index = [];
for (const p of pages) {
  const html = renderer(p).render(p.text);
  fs.mkdirSync(path.dirname(path.join(OUT, p.url)), { recursive: true });
  fs.writeFileSync(path.join(OUT, p.url), layout(p.url, p.title, `<article>${html}</article>`));
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
  index.push({ t: p.title, u: p.url, g: p.group, x: plain });
}
fs.writeFileSync(path.join(OUT, 'search-index.json'), JSON.stringify(index));

// Home
const home = `<article><h1>${escHtml(SITE)}</h1>
<p>Design documents, ADRs and research notes${AGENT ? ' and the agent-server runbook' : ''}.${plugin ? ` Built with a
sanitiser plugin (see the <a href="sanitisation-report.html">sanitisation report</a>).` : ''}</p>
${GROUPS.map((g) => `<h2>${g}</h2><ul>${pages.filter((p) => p.group === g).map((p) => `<li><a href="${p.url}">${escHtml(p.title)}</a></li>`).join('')}</ul>`).join('\n')}
</article>`;
fs.writeFileSync(path.join(OUT, 'index.html'), layout('index.html', 'Home', home));

// Sanitisation report (labels and counts only)
let rmd = `# Sanitisation report\n\nBuilt ${builtAt} from ${PRODUCT} \`${hlSha}\` and agent-server \`${agentSha}\`. ` +
  `Rules record labels and counts only, never the removed text.\n\n| Page | Source | Redactions |\n|---|---|---|\n`;
for (const r of report)
  rmd += `| ${r.key} | \`${r.src}\` | ${r.log.length ? r.log.map((l) => `${l.rule} (×${l.count})`).join('<br>') : '—'} |\n`;
const totals = report.reduce((a, r) => a + r.log.reduce((b, l) => b + l.count, 0), 0);
rmd += `\nTotal: ${totals} redactions across ${report.filter((r) => r.log.length).length} of ${report.length} pages.\n`;

// Denylist gate over everything in dist (+ the report itself)
const denylist = buildDenylist(REPO);
let hits = scanDir(OUT, denylist);
rmd += `\n## Denylist gate\n\n${plugin ? `${denylist.length} patterns from the sanitiser plugin. ` +
  `Result: ${hits.length ? `**FAILED** (${hits.length} hits)` : '**passed** (0 hits)'}.` : 'Not run: no sanitiser plugin (the product docs carry no PHI).'}\n`;
fs.mkdirSync(path.join(REPO, 'site'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'site/sanitisation-report.md'), rmd);
const rp = { key: 'sanitisation-report', src: path.join(REPO, 'site/sanitisation-report.md'), url: 'sanitisation-report.html' };
fs.writeFileSync(path.join(OUT, rp.url), layout(rp.url, 'Sanitisation report', `<article>${renderer(rp).render(rmd.replace(/<br>/g, '; '))}</article>`));
hits = scanDir(OUT, denylist);

console.log(rmd);
if (hits.length) {
  console.error('\nDENYLIST GATE FAILED — matched text is not printed; inspect these locations:');
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.label}]`);
  fs.rmSync(OUT, { recursive: true, force: true });
  console.error('site/dist removed.');
  process.exit(1);
}
console.log(`ok: ${pages.length} doc pages + home + report -> ${path.relative(REPO, OUT)}`);
