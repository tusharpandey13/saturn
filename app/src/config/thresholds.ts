// Red-flag thresholds: the shape, the validator and the built-in default. DATA, not logic: the rules in src/rules
// read only from here.
//
// The product ships NO clinical values. The values belong to the records repo, in config/thresholds.yaml
// (docs/records-guide.md), loaded by src/batch/records.ts. Without that file the built-in default is DISABLED:
// the rule engine emits no annotations and the digest says thresholds are not configured.
// Keys in the YAML file are the same camelCase names as below; unknown keys and wrong types are rejected.
// When the treating clinician personalises values, the records owner bumps `version`, sets `setBy` and `effectiveFrom`.
import { parse } from "yaml";
import { z } from "zod";

const num = z.number().finite();
const count = z.number().int().positive();

export const ThresholdsSchema = z.strictObject({
  version: z.string().min(1),
  status: z.enum(["pending_clinician_signoff", "signed_off"]),
  setBy: z.string().min(1),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),

  spo2: z.strictObject({ tier1Below: num, tier1WithBreathlessnessAtOrBelow: num, tier2AtOrBelow: num }),
  pulse: z.strictObject({ tier1Below: num, tier1BelowWithSymptoms: num, tier1Above: num, tier2Below: num }),
  sbp: z.strictObject({ tier1BelowWithSymptoms: num, tier2BelowWithDizziness: num, tier3Below: num }),
  labs: z.strictObject({
    potassiumTier1AtOrAbove: num,
    potassiumTier2Above: num,
    sodiumTier2Below: num,
    creatinineTier2AboveMgDl: num,
  }),
  weight: z.strictObject({
    /** gain (kg) vs the lowest reading in the window of N previous calendar days -> tier 2 */
    gainTier2: z.array(z.strictObject({ days: count, kg: num, source: z.string() })),
    /** gain > kg vs the lowest reading of the previous windowDays, on each of consecutiveDays days in a row -> tier 2 */
    sustainedGainTier2: z.strictObject({ windowDays: count, kg: num, consecutiveDays: count }),
    /** loss (kg) over N days, tier 2 only together with dizziness */
    lossWithDizzinessTier2: z.strictObject({ days: count, kg: num }),
  }),
  chestPainTier1MinDurationMin: num,
  /** Breathlessness with at_rest unknown and severity >= this -> tier 2 plus a follow-up question. */
  breathlessUnknownRestTier2Severity: num,
});

/** Thresholds loaded from a records repo. */
export type Thresholds = z.infer<typeof ThresholdsSchema>;

/** No thresholds configured: the rules are off. */
export interface DisabledThresholds {
  status: "disabled";
}

export type ThresholdsConfig = Thresholds | DisabledThresholds;

/** Built-in default: neutral. No values, no annotations. */
export const DISABLED_THRESHOLDS: DisabledThresholds = Object.freeze({ status: "disabled" as const });

export const thresholdsEnabled = (t: ThresholdsConfig): t is Thresholds => t.status !== "disabled";

/** Parse and validate config/thresholds.yaml text. Fails closed: any YAML or schema problem throws. */
export function parseThresholdsYaml(text: string, where = "config/thresholds.yaml"): Thresholds {
  let raw: unknown;
  try {
    raw = parse(text, { uniqueKeys: true });
  } catch (err) {
    throw new Error(`${where}: not valid YAML (${(err as Error).message.split("\n")[0]})`);
  }
  const r = ThresholdsSchema.safeParse(raw);
  if (!r.success)
    throw new Error(`${where}: invalid thresholds; ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}
