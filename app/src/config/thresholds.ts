// Red-flag thresholds. DATA, not logic: the rules in src/rules read only from here.
//
// STATUS: PENDING CLINICIAN SIGN-OFF.
// Conservative generic defaults, transcribed from published guidelines (sources [Sn] below; the list lives with the
// records, as a reference page). Per-person overrides belong to the records repo, not here.
// Rows marked PLACEHOLDER there have no guideline number; the doctor must confirm or replace them.
// When the treating clinician personalises values, bump `version`, set `setBy` and `effectiveFrom`.

export interface Thresholds {
  version: string;
  status: "pending_clinician_signoff" | "signed_off";
  setBy: string;
  effectiveFrom: string;

  spo2: { tier1Below: number; tier1WithBreathlessnessAtOrBelow: number; tier2AtOrBelow: number };
  pulse: { tier1Below: number; tier1BelowWithSymptoms: number; tier1Above: number; tier2Below: number };
  sbp: { tier1BelowWithSymptoms: number; tier2BelowWithDizziness: number; tier3Below: number };
  labs: {
    potassiumTier1AtOrAbove: number;
    potassiumTier2Above: number;
    sodiumTier2Below: number;
    creatinineTier2AboveMgDl: number;
  };
  weight: {
    /** gain (kg) vs the lowest reading in the window of N previous calendar days -> tier 2 */
    gainTier2: { days: number; kg: number; source: string }[];
    /** gain > kg vs the lowest reading of the previous windowDays, on each of consecutiveDays days in a row -> tier 2 */
    sustainedGainTier2: { windowDays: number; kg: number; consecutiveDays: number };
    /** loss (kg) over N days, tier 2 only together with dizziness */
    lossWithDizzinessTier2: { days: number; kg: number };
  };
  chestPainTier1MinDurationMin: number;
  /** Breathlessness with at_rest unknown and severity >= this -> tier 2 plus a follow-up question. */
  breathlessUnknownRestTier2Severity: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  version: "2026-10-24-defaults",
  status: "pending_clinician_signoff",
  setBy: "generic guideline defaults (not a doctor)",
  effectiveFrom: "2026-10-24",

  // ESC 2021 <90 [S15]; NHS oximetry <=92 with symptoms / 93-94 contact GP [S14]
  spo2: { tier1Below: 90, tier1WithBreathlessnessAtOrBelow: 92, tier2AtOrBelow: 94 },
  // <40 PLACEHOLDER; <50 + symptoms [S8, S18]; >130 PLACEHOLDER (lower end of 130-150, conservative)
  pulse: { tier1Below: 40, tier1BelowWithSymptoms: 50, tier1Above: 130, tier2Below: 50 },
  // <80 symptomatic PLACEHOLDER [Island Health]; <90 with dizziness [S8, S19]; asymptomatic low BP logged
  sbp: { tier1BelowWithSymptoms: 80, tier2BelowWithDizziness: 90, tier3Below: 95 },
  // SIGN MRA / NHS SPS [S8, S9]; Na <130 PLACEHOLDER
  labs: {
    potassiumTier1AtOrAbove: 6.0,
    potassiumTier2Above: 5.5,
    sodiumTier2Below: 130,
    creatinineTier2AboveMgDl: 2.5,
  },
  weight: {
    gainTier2: [
      { days: 1, kg: 1.5, source: "AHA >2-3 lb in 24 h [S11]" },
      { days: 3, kg: 2.0, source: "HFA >2 kg in 3 days [S7, S10]" },
      { days: 7, kg: 2.3, source: "AHA 5 lb in a week [S11]" },
    ],
    // SIGN/McMurray beta-blocker annex: >1 kg over 3 days persisting >2 days [S8 Annex 4]
    sustainedGainTier2: { windowDays: 3, kg: 1.0, consecutiveDays: 3 },
    lossWithDizzinessTier2: { days: 3, kg: 2.0 }, // PLACEHOLDER magnitude [S7]
  },
  // ACS public advice, PLACEHOLDER duration. Unknown duration is treated as tier 1.
  chestPainTier1MinDurationMin: 15,
  // PLACEHOLDER: unknown whether at rest; conservative escalation pending clarification
  breathlessUnknownRestTier2Severity: 7,
};
