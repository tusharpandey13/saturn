// Subject attribution (v0.3.0, ADR 009): a member may log for another member ("maa 116/47" from the father).
// The aliases (name prefixes) come from the records repo (records.yaml `aliases:`), never from product code: the batch
// syncs them into D1 (table aliases) for the Worker, and reads records.yaml itself. Both sides use this one parser so
// the stored subject and the echoed one agree.

export interface Alias {
  /** As configured (matched case-insensitively, NFC). */
  alias: string;
  /** D1 person id of the subject. */
  personId: string;
  /** Name shown in the echo and the digest (records.yaml namespaces display). */
  display: string;
}

const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase("en");
const BOUNDARY = /^($|[\s:,.;!?\-–—])/u;
const SEP = /^[\s:,.;\-–—]+/u;
// "maa ka BP", "papa ki sugar", "मां का BP": a possessive after the name is part of the prefix.
const POSSESSIVE = /^(ka|ki|ke|का|की|के)(?=$|[\s:,.;\-–—])[\s:,.;\-–—]*/iu;

/** A leading name prefix -> the subject and the text without the prefix. No prefix: subject null, text unchanged. */
export function splitSubject(text: string | undefined, aliases: Alias[]): { subject: Alias | null; rest: string | undefined } {
  if (!text) return { subject: null, rest: text };
  const t = text.normalize("NFC").trimStart();
  const low = norm(t);
  const sorted = [...aliases].filter((a) => a.alias.trim()).sort((a, b) => b.alias.length - a.alias.length);
  for (const a of sorted) {
    const al = norm(a.alias.trim());
    if (!low.startsWith(al) || !BOUNDARY.test(low.slice(al.length))) continue;
    let rest = t.slice(al.length).replace(SEP, "");
    rest = rest.replace(POSSESSIVE, "");
    return { subject: a, rest };
  }
  return { subject: null, rest: text };
}

/** "/for maa" or "/for@bot maa" -> "maa"; anything else -> null. */
export function parseForCommand(text: string | undefined): string | null {
  const m = /^\/for(?:@\w+)?\s+(.+)$/isu.exec(text?.trim() ?? "");
  return m ? m[1].trim() : null;
}

/** The alias (or person id, or display name) named in a /for command. */
export function resolveName(name: string, aliases: Alias[], personIds: string[]): { personId: string; display: string } | null {
  const n = norm(name.trim());
  const a = aliases.find((x) => norm(x.alias) === n) ?? aliases.find((x) => norm(x.display) === n);
  if (a) return { personId: a.personId, display: a.display };
  const id = personIds.find((p) => norm(p) === n);
  return id ? { personId: id, display: displayOf(id, aliases) ?? id } : null;
}

/** Display name for a D1 person id from the aliases, if any. */
export function displayOf(personId: string, aliases: Alias[]): string | null {
  return aliases.find((a) => a.personId === personId)?.display ?? null;
}

/** records.yaml `aliases:` ({ns: [names]}) -> Alias rows keyed by D1 person id (inverse d1_person_map, same id otherwise). */
export function aliasesFromRecords(byNs: Record<string, string[]>, display: Record<string, string>, d1PersonMap: Record<string, string>): Alias[] {
  const d1Of = (ns: string) => Object.entries(d1PersonMap).find(([, v]) => v === ns)?.[0] ?? ns;
  return Object.entries(byNs).flatMap(([ns, names]) => names.map((alias) => ({ alias, personId: d1Of(ns), display: display[ns] ?? ns })));
}
