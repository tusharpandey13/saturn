// Mobile nav, tiny client-side search, Mermaid (jsdelivr ESM, loaded only when a page has diagrams).
const root = document.body.dataset.root || './';
const nav = document.getElementById('nav');
const menu = document.getElementById('menu');
menu.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
});

const q = document.getElementById('q');
const results = document.getElementById('results');
let index = null;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function search() {
  const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) { results.hidden = true; return; }
  index ??= await (await fetch(root + 'search-index.json')).json();
  const hits = [];
  for (const d of index) {
    const hay = (d.t + ' ' + d.x).toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const score = terms.reduce((s, t) => s + (d.t.toLowerCase().includes(t) ? 10 : 0) + hay.split(t).length - 1, 0);
    const at = Math.max(0, d.x.toLowerCase().indexOf(terms[0]) - 60);
    hits.push({ d, score, snip: d.x.slice(at, at + 160) });
  }
  hits.sort((a, b) => b.score - a.score);
  results.innerHTML = hits.length
    ? hits.slice(0, 20).map((h) => `<a href="${root}${h.d.u}">${esc(h.d.t)}<small>${esc(h.d.g)} · …${esc(h.snip)}…</small></a>`).join('')
    : '<p>No matches.</p>';
  results.hidden = false;
}
let timer;
q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 120); });
q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; results.hidden = true; } });
document.addEventListener('click', (e) => { if (!results.contains(e.target) && e.target !== q) results.hidden = true; });

if (document.querySelector('pre.mermaid')) {
  const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  await mermaid.run({ querySelector: 'pre.mermaid' });
}
