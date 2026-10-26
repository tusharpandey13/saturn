// Records repo manifest for the batch (split plan section 5): records.yaml supplies the D1 person map and the
// schema version; meta/ supplies per-records extras. Same YAML subset as tools/kb/records_config.py.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_SCHEMA_VERSIONS = [7];

export interface RecordsConfig {
  schemaVersion: number;
  namespaces: string[];
  d1PersonMap: Record<string, string>;
  /** Extra STT key terms (meta/stt-vocab.txt), raw text; parse with parseVocab. */
  sttVocab: string | null;
  /** Who the senders are, for the extraction prompt (meta/extraction-context.md). */
  extractionContext: string | null;
}

const scalar = (v: string): string => v.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");

/** Parse the records.yaml subset: top-level scalars, `namespaces:` list of `- id:` maps, `d1_person_map:` map. */
export function parseRecordsYaml(text: string): Pick<RecordsConfig, "schemaVersion" | "namespaces" | "d1PersonMap"> {
  let key = "";
  const top: Record<string, string> = {};
  const namespaces: string[] = [];
  const d1PersonMap: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const top1 = /^([A-Za-z0-9_]+):(.*)$/.exec(raw);
    if (top1) {
      key = top1[1];
      top[key] = scalar(top1[2]);
      continue;
    }
    const item = /^\s+(- )?([A-Za-z0-9_.-]+):(.*)$/.exec(raw);
    if (!item) throw new Error("records.yaml: unparsable line");
    if (key === "namespaces" && item[1] && item[2] === "id") namespaces.push(scalar(item[3]));
    if (key === "d1_person_map" && !item[1]) d1PersonMap[item[2]] = scalar(item[3]);
  }
  return { schemaVersion: Number(top.schema_version), namespaces, d1PersonMap };
}

export function loadRecords(root: string): RecordsConfig {
  const path = join(root, "records.yaml");
  if (!existsSync(path)) throw new Error(`records.yaml not found under --records ${root}`);
  const y = parseRecordsYaml(readFileSync(path, "utf8"));
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(y.schemaVersion))
    throw new Error(`records.yaml schema_version ${y.schemaVersion} not supported (this product reads ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`);
  if (!y.namespaces.length) throw new Error("records.yaml: no namespaces");
  for (const [k, v] of Object.entries(y.d1PersonMap))
    if (!y.namespaces.includes(v)) throw new Error(`records.yaml: d1_person_map ${k} -> ${v} is not a namespace`);
  const opt = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  return { ...y, sttVocab: opt("meta/stt-vocab.txt"), extractionContext: opt("meta/extraction-context.md") };
}
