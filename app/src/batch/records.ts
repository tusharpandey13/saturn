// Records repo manifest for the batch (split plan section 5): records.yaml supplies the D1 person map and the
// schema version; meta/ supplies per-records extras; config/thresholds.yaml supplies the red-flag thresholds
// (validated; absent = rules disabled). Same YAML subset as tools/kb/records_config.py.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISABLED_THRESHOLDS, parseThresholdsYaml, type ThresholdsConfig } from "../config/thresholds.js";

export const SUPPORTED_SCHEMA_VERSIONS = [7];

export interface RecordsConfig {
  schemaVersion: number;
  namespaces: string[];
  d1PersonMap: Record<string, string>;
  /** Namespace display names (namespaces: display). */
  display: Record<string, string>;
  /** Name prefixes per namespace (aliases: {ns: [names]}), e.g. a message "maa 116/47" is about the ns listed for "maa". */
  aliases: Record<string, string[]>;
  /** Extra STT key terms (meta/stt-vocab.txt), raw text; parse with parseVocab. */
  sttVocab: string | null;
  /** Who the senders are, for the extraction prompt (meta/extraction-context.md). */
  extractionContext: string | null;
  /** config/thresholds.yaml, validated; DISABLED_THRESHOLDS when the file is absent. */
  thresholds: ThresholdsConfig;
}

const scalar = (v: string): string => v.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");

const list = (v: string): string[] =>
  scalar(v).replace(/^\[(.*)\]$/, "$1").split(",").map((x) => x.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);

/** Parse the records.yaml subset: top-level scalars, `namespaces:` list of `- id:` maps, `d1_person_map:` and
 *  `aliases:` maps (an alias value is a flow list `[a, b]` or `a, b`). */
export function parseRecordsYaml(text: string): Pick<RecordsConfig, "schemaVersion" | "namespaces" | "d1PersonMap" | "display" | "aliases"> {
  let key = "";
  const top: Record<string, string> = {};
  const namespaces: string[] = [];
  const d1PersonMap: Record<string, string> = {};
  const display: Record<string, string> = {};
  const aliases: Record<string, string[]> = {};
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
    if (key === "namespaces" && !item[1] && item[2] === "display" && namespaces.length) display[namespaces[namespaces.length - 1]] = scalar(item[3]);
    if (key === "d1_person_map" && !item[1]) d1PersonMap[item[2]] = scalar(item[3]);
    if (key === "aliases" && !item[1]) aliases[item[2]] = list(item[3]);
  }
  return { schemaVersion: Number(top.schema_version), namespaces, d1PersonMap, display, aliases };
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
  const seen = new Map<string, string>();
  for (const [ns, names] of Object.entries(y.aliases)) {
    if (!y.namespaces.includes(ns)) throw new Error(`records.yaml: aliases ${ns} is not a namespace`);
    for (const n of names) {
      const k = n.normalize("NFC").toLocaleLowerCase("en");
      if (seen.has(k) && seen.get(k) !== ns) throw new Error(`records.yaml: alias "${n}" names two namespaces`);
      seen.set(k, ns);
    }
  }
  const opt = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  return { ...y, sttVocab: opt("meta/stt-vocab.txt"), extractionContext: opt("meta/extraction-context.md"), thresholds: loadThresholds(root) };
}

/** config/thresholds.yaml under a records root. Absent: disabled. Present but invalid: throws (fail closed). */
export function loadThresholds(root: string): ThresholdsConfig {
  const path = join(root, "config", "thresholds.yaml");
  return existsSync(path) ? parseThresholdsYaml(readFileSync(path, "utf8")) : DISABLED_THRESHOLDS;
}
