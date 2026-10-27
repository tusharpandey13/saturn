// Life-context signals (ADR 010): pre-filter, minimisation and the prompt/schema contract. Synthetic members only.
import { describe, expect, it } from "vitest";
import { BATCH_SCHEMA } from "../../adapters/llm/claude-cli.js";
import { systemPrompt } from "../src/extract/adapter.js";
import { CAUSAL, CONTEXT_CATEGORIES, contextEligible, isPrivate, parseContext, parseContextMode, sharesFourGram } from "../src/extract/context.js";
import { EXTRACTION_SCHEMA, parseExtraction } from "../src/extract/schema.js";
import { ALIASES } from "./helpers.js";

const TS = "2026-10-25T05:00:00.000Z"; // 10:30 IST
const TEXT = "aaj office mein bahut tension hai, kal deadline hai";
const base = { text: TEXT, ts: TS, sender: "alice", aliases: ALIASES, personIds: ["alice", "bob", "carol-tg"], consented: (p: string) => p === "alice" || p === "carol-tg" };
const item = (o: Record<string, unknown> = {}) => ({ category: "stress", about: "sender", summary: "feeling work pressure before a deadline", intensity: "high", confidence: "high", start: null, end: null, ...o });
const parse = (items: unknown[], o: Partial<typeof base> = {}) => parseContext({ context: items }, { ...base, ...o });

describe("parseContext (minimisation)", () => {
  it("keeps a valid signal about the sender, on the message's IST day", () => {
    expect(parse([item()])).toEqual({ signals: [{ subject: "alice", category: "stress", summary: "feeling work pressure before a deadline", intensity: "high", confidence: "high", start: "2026-10-25", end: null }], dropped: 0 });
  });

  it("a signal about another consented member by name; a stated period is kept, a far one falls back", () => {
    const r = parse([item({ about: "Carol", category: "travel", summary: "Carol away for a few days", start: "2026-10-26", end: "2026-10-29" }), item({ start: "2025-01-01", end: "2027-01-01" })]);
    expect(r.signals.map((s) => [s.subject, s.start, s.end])).toEqual([["carol-tg", "2026-10-26", "2026-10-29"], ["alice", "2026-10-25", null]]);
  });

  it.each([
    ["out of vocabulary", { category: "other" }],
    ["a non-member", { about: "a friend" }],
    ["a member without consent", { about: "Bob" }], // bob: consent pending
    ["a quote (4-word run of the message)", { summary: "office mein bahut tension hai" }],
    ["a name that is not a member", { summary: "worried about Ravi at work" }],
    ["causal phrasing", { summary: "stressed because of a deadline" }],
    ["quotation marks", { summary: 'said "very tired"' }],
    ["over 80 characters", { summary: "x".repeat(81) }],
    ["an empty summary", { summary: "  " }],
  ])("drops %s", (_what, o) => {
    expect(parse([item(o)])).toEqual({ signals: [], dropped: 1 });
  });

  it("reads at most 3 items per message and counts the rest as dropped", () => {
    const r = parse([item(), item({ category: "sleep", summary: "sleeping poorly" }), item({ category: "mood", summary: "feeling low" }), item({ category: "activity", summary: "walking daily" })]);
    expect(r.signals).toHaveLength(3);
    expect(r.dropped).toBe(1);
  });

  it("a sender without consent gets nothing, even about themselves", () => {
    expect(parse([item()], { sender: "bob" }).signals).toEqual([]);
  });

  it("never throws on junk", () => {
    expect(parseContext(null, base)).toEqual({ signals: [], dropped: 0 });
    expect(parseContext({ context: "x" }, base)).toEqual({ signals: [], dropped: 0 });
    expect(parse([{ nope: 1 }]).dropped).toBe(1);
  });

  it("4-gram overlap ignores case and punctuation; causal lint covers Hindi and Hinglish", () => {
    expect(sharesFourGram("Bahut tension hai, kal", "aaj BAHUT tension hai kal!")).toBe(true);
    expect(sharesFourGram("feeling work pressure", TEXT)).toBe(false);
    for (const t of ["due to travel", "led to poor sleep", "tension के कारण", "travel se hua"]) expect(CAUSAL.test(t)).toBe(true);
    for (const t of ["around the same dates", "alongside travel", "during a festival"]) expect(CAUSAL.test(t)).toBe(false);
  });
});

describe("pre-filter and /private", () => {
  const ok = { mode: "shadow" as const, senderConsented: true, text: TEXT, forwarded: false, vitalsOnly: false };
  it("needs a mode, consent, >= 4 words, not forwarded, not vitals-only", () => {
    expect(contextEligible(ok)).toBe(true);
    expect(contextEligible({ ...ok, mode: "off" })).toBe(false);
    expect(contextEligible({ ...ok, senderConsented: false })).toBe(false);
    expect(contextEligible({ ...ok, forwarded: true })).toBe(false);
    expect(contextEligible({ ...ok, vitalsOnly: true })).toBe(false);
    expect(contextEligible({ ...ok, text: "good morning 🙏 🌸" })).toBe(false);
    expect(contextEligible({ ...ok, text: undefined })).toBe(false);
  });
  it("/private only at the start", () => {
    expect(isPrivate("/private feeling low today")).toBe(true);
    expect(isPrivate("  /PRIVATE")).toBe(true);
    expect(isPrivate("/privately")).toBe(false);
    expect(isPrivate("not /private")).toBe(false);
  });
  it("context_mode: unknown or unset is off", () => {
    expect(parseContextMode(undefined)).toBe("off");
    expect(parseContextMode("loud")).toBe("off");
    expect(parseContextMode("shadow")).toBe("shadow");
  });
});

describe("one combined extraction call (schema and prompt)", () => {
  it("the schema has context[] with the closed vocabulary; health fields unchanged", () => {
    expect(EXTRACTION_SCHEMA.required).toEqual(expect.arrayContaining(["readings", "symptoms", "context"]));
    const c = (EXTRACTION_SCHEMA.properties.context as any).items;
    expect(c.properties.category.enum).toEqual([...CONTEXT_CATEGORIES]);
    expect(c.additionalProperties).toBe(false);
    expect((BATCH_SCHEMA.properties.results.items.properties as any).context).toBeDefined();
  });
  it("the prompt reads context only for context: yes headers and forbids quotes, third parties and causes", () => {
    const p = systemPrompt();
    expect(p).toContain('header says "context: yes"');
    expect(p).toMatch(/Never quote the message/);
    expect(p).toMatch(/Never a friend, relative, colleague/);
    expect(p).toMatch(/Never say why/);
  });
  it("health parsing ignores the context field", () => {
    const ex = parseExtraction({ media_kind: "none", readings: [{ type: "bp", value: 130, value2: 85, value3: null, unit: "mmHg", measured_at: null }], symptoms: [], confidence: 0.9, unreadable_reason: null, subject_hint: null, context: [item()] }, TS);
    expect(ex.readings).toHaveLength(1);
    expect(ex.rejected).toEqual([]);
  });
});
