import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACTION_SCHEMA, parseExtraction } from "../src/extract/schema.js";

const NOW = "2026-10-24T08:00:00+05:30";
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "app", `${name}.json`), "utf8"));

describe("parseExtraction", () => {
  it("parses a BP monitor photo", () => {
    const ex = parseExtraction(fx("bp-photo"), NOW);
    expect(ex.readings).toEqual([{ type: "bp", value: 128, value2: 82, value3: 76, unit: "mmHg", measuredAt: NOW }]);
    expect(ex.confidence).toBe(0.93);
    expect(ex.rejected).toEqual([]);
  });

  it("accepts a JSON string (raw model text)", () => {
    const ex = parseExtraction(JSON.stringify(fx("oximeter-low")), NOW);
    expect(ex.readings.map((r) => [r.type, r.value])).toEqual([["spo2", 88], ["pulse", 104]]);
  });

  it("drops implausible, swapped or malformed values and clamps confidence", () => {
    const ex = parseExtraction(fx("implausible"), NOW);
    expect(ex.readings).toEqual([]);
    expect(ex.symptoms).toEqual([]);
    expect(ex.rejected).toHaveLength(5);
    expect(ex.rejected.join(" ")).toMatch(/bp 82\/128 implausible/);
    expect(ex.confidence).toBe(1);
  });

  it("maps symptoms and nulls out-of-range severity", () => {
    const ex = parseExtraction(fx("voice-chest-pain"), NOW);
    expect(ex.symptoms[0]).toMatchObject({ symptomType: "chest_pain", durationMin: 20, atRest: true, associated: ["sweating"], severity: 7 });
    expect(ex.symptoms[1]).toMatchObject({ symptomType: "tingling", side: "both", severity: null });
  });

  it("keeps a valid measured_at from a report and falls back to message time otherwise", () => {
    const ex = parseExtraction(fx("lab-report"), NOW);
    expect(ex.readings[0].measuredAt).toBe("2026-10-20T09:00:00+05:30");
    expect(ex.readings[2].measuredAt).toBe(NOW);
  });

  it("classifies photos first: non_health drops any values and the unreadable reason (source only, no question)", () => {
    const ex = parseExtraction(fx("non-health-screenshot"), NOW);
    expect(ex).toMatchObject({ mediaKind: "non_health", readings: [], symptoms: [], unreadableReason: null, rejected: [], outOfRange: [] });
    const blurry = parseExtraction(fx("blurry-bp-monitor"), NOW);
    expect(blurry).toMatchObject({ mediaKind: "device_reading", readings: [], unreadableReason: "display blurred" });
    expect(EXTRACTION_SCHEMA.required[0]).toBe("media_kind"); // the model classifies before it extracts
    expect((EXTRACTION_SCHEMA.properties.media_kind as { enum: string[] }).enum).toContain("non_health");
  });

  it("reports unreadable images and invalid JSON without throwing", () => {
    expect(parseExtraction(fx("unreadable"), NOW).unreadableReason).toBe("glare covers the display");
    const bad = parseExtraction("{not json", NOW);
    expect(bad.readings).toEqual([]);
    expect(bad.unreadableReason).toMatch(/invalid JSON/);
    expect(parseExtraction(null, NOW).readings).toEqual([]);
  });

  it("subject_hint: kept as written (trimmed, capped); absent, empty or a self/none placeholder is null", () => {
    expect(parseExtraction({ readings: [], symptoms: [], subject_hint: "  Maa " }, NOW).subjectHint).toBe("Maa");
    expect(parseExtraction({ readings: [], symptoms: [], subject_hint: "x".repeat(200) }, NOW).subjectHint).toHaveLength(80);
    for (const v of [undefined, null, "", "none", "self", "null", 3]) expect(parseExtraction({ readings: [], symptoms: [], subject_hint: v }, NOW).subjectHint).toBeNull();
    expect(EXTRACTION_SCHEMA.required).toContain("subject_hint");
  });

  it("schema is strict-compatible: every object lists all properties as required", () => {
    const walk = (s: any): void => {
      if (s?.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
        Object.values(s.properties).forEach(walk);
      }
      if (s?.items) walk(s.items);
    };
    walk(EXTRACTION_SCHEMA);
  });
});
