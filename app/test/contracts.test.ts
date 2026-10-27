// Product <-> environment / records contracts (split plan section 5): records.yaml, env.manifest.yaml, the wrangler template.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { keytermsWith, parseVocab } from "../../adapters/stt/sarvam.js";
import { systemPrompt } from "../src/extract/adapter.js";
import { loadRecords, parseRecordsYaml } from "../src/batch/records.js";
import { check, render } from "../scripts/render.js";

const ROOT = join(import.meta.dirname, "..", "..");
const EXAMPLE = join(ROOT, "fixtures", "records-example");
const manifest = parse(readFileSync(join(ROOT, "env.manifest.yaml"), "utf8"));
const exampleEnv = parse(readFileSync(join(ROOT, "deploy", "env.example.yaml"), "utf8"));

describe("records.yaml", () => {
  it("loads namespaces, the D1 person map and the meta extras from the example records", () => {
    const r = loadRecords(EXAMPLE);
    expect(r.schemaVersion).toBe(7);
    expect(r.namespaces).toEqual(["alice", "bob", "carol", "family"]);
    expect(r.d1PersonMap).toEqual({ "carol-tg": "carol" });
    expect(parseVocab(r.sttVocab ?? "")).toEqual(["Examplezole"]);
    expect(systemPrompt(r.extractionContext)).toContain("synthetic members alice, bob and carol");
  });

  it("refuses an unsupported schema_version and a map to an unknown namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "saturn-rec-"));
    writeFileSync(join(dir, "records.yaml"), "schema_version: 6\nnamespaces:\n  - id: a\n");
    expect(() => loadRecords(dir)).toThrow(/schema_version 6 not supported/);
    writeFileSync(join(dir, "records.yaml"), "schema_version: 7\nnamespaces:\n  - id: a\nd1_person_map:\n  carol-tg: z\n");
    expect(() => loadRecords(dir)).toThrow(/not a namespace/);
    expect(parseRecordsYaml("schema_version: 7 # c\nnamespaces:\n  - id: x\n    display: X\n").namespaces).toEqual(["x"]);
  });

  it("the product prompt names nobody without records context", () => {
    expect(systemPrompt()).toContain("Senders are family members. Each message is recorded for its sender.");
    expect(systemPrompt()).not.toMatch(/patient|caregiver/i);
    expect(systemPrompt()).toContain("subject_hint");
  });

  it("STT key terms: generic first, records vocabulary appended, deduplicated and capped", () => {
    expect(keytermsWith(["bp", "Examplezole"])).toEqual(["BP", "pulse", "SpO2", "oximeter", "glucometer", "sugar", "weight", "Examplezole"]);
    expect(keytermsWith(Array.from({ length: 80 }, (_, i) => `t${i}`))).toHaveLength(50);
  });

  it("the manifest supports the example records' schema version", () => {
    expect(manifest.records_schema_versions).toContain(loadRecords(EXAMPLE).schemaVersion);
  });
});

describe("env.manifest.yaml + wrangler template", () => {
  it("the example env passes the manifest check", () => {
    expect(check(exampleEnv, manifest)).toEqual([]);
  });

  it("reports missing and mistyped vars and unknown adapters", () => {
    const bad = { ...exampleEnv, go_live: "no", cloudflare: { ...exampleEnv.cloudflare, worker_name: "" }, batch: { ...exampleEnv.batch, llm_adapter: "other" } };
    expect(check(bad, manifest)).toEqual(expect.arrayContaining(["go_live: expected bool", "cloudflare.worker_name: required (str)", "batch.llm_adapter: other is not one of claude-cli, fake"]));
  });

  it("ack_mode: one of off | vitals-only | all; rendered as the Worker var ACK_MODE (line dropped when unset)", () => {
    expect(check({ ...exampleEnv, ack_mode: "loud" }, manifest)).toEqual(["ack_mode: loud is not one of off, vitals-only, all"]);
    expect(check({ ...exampleEnv, ack_mode: "off" }, manifest)).toEqual([]);
    const tpl = readFileSync(join(ROOT, "deploy", "wrangler.template.toml"), "utf8");
    expect(render(tpl, { ...exampleEnv, ack_mode: "off" })).toContain('ACK_MODE = "off"');
    expect(render(tpl, { ...exampleEnv, ack_mode: undefined })).not.toMatch(/^ACK_MODE =/m);
  });

  it("drops the database_id line until the env pins an id (wrangler auto-provisions), then renders it", () => {
    const tpl = readFileSync(join(ROOT, "deploy", "wrangler.template.toml"), "utf8");
    expect(render(tpl, exampleEnv)).not.toMatch(/^database_id =/m);
    const pinned = { ...exampleEnv, cloudflare: { ...exampleEnv.cloudflare, d1: { name: "saturn", id: "11111111-2222-4333-8444-555555555555" } } };
    expect(render(tpl, pinned)).toContain('database_id = "11111111-2222-4333-8444-555555555555"');
    expect(render(tpl, exampleEnv)).toContain('bucket_name = "saturn-media"');
  });
});
