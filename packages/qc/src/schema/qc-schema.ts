import { z } from "zod";

/**
 * Per-shot visual QC result schema (spec §20, runbook §24 "QC/routing").
 *
 * Every generated shot is QC'd before final use against the full spec §20
 * check list — exactly these 17 checks, each reported once:
 *   character identity; face consistency; skin tone; hair; wardrobe;
 *   accessories; body/anatomy artifacts; props; location; lighting
 *   continuity; camera requirement; action requirement; visual artifacts;
 *   lip/face problems; start/end state; neighboring-shot continuity;
 *   dialogue suitability.
 *
 * Verdicts map onto the spec §18 shot state machine: PASS → APPROVED,
 * FAIL → QC_FIXING (targeted repair/regeneration of this shot only),
 * REVIEW → human REVIEW state (automated routes exhausted).
 *
 * The result is versioned (`schemaVersion` gates structural changes) and
 * every verdict carries evidence; evidence may reference extracted frames
 * (spec §20: video-capable multimodal models review video directly when
 * possible, otherwise FFmpeg extracts representative frames for
 * image-vision QC).
 */

/** Bump on any structural change to the QC result shape. */
export const QC_RESULT_SCHEMA_VERSION = 1 as const;

/**
 * The 17 spec §20 checks. `QC_CHECK_IDS` order is canonical — reports and
 * UIs must render checks in this order (identity → appearance → continuity
 * → performance).
 */
export const QC_CHECK_IDS = [
  "character-identity",
  "face-consistency",
  "skin-tone",
  "hair",
  "wardrobe",
  "accessories",
  "anatomy-artifacts",
  "props",
  "location",
  "lighting-continuity",
  "camera-requirement",
  "action-requirement",
  "visual-artifacts",
  "lip-face",
  "start-end-state",
  "neighbor-continuity",
  "dialogue-suitability",
] as const;

export type QcCheckId = (typeof QC_CHECK_IDS)[number];

export const qcCheckIdSchema = z.enum(QC_CHECK_IDS);

/** Human-readable label per check, keyed by check id (same order). */
export const QC_CHECK_LABELS: Readonly<Record<QcCheckId, string>> = {
  "character-identity": "Character identity",
  "face-consistency": "Face consistency",
  "skin-tone": "Skin tone",
  hair: "Hair",
  wardrobe: "Wardrobe",
  accessories: "Accessories",
  "anatomy-artifacts": "Body/anatomy artifacts",
  props: "Props",
  location: "Location",
  "lighting-continuity": "Lighting continuity",
  "camera-requirement": "Camera requirement",
  "action-requirement": "Action requirement",
  "visual-artifacts": "Visual artifacts",
  "lip-face": "Lip/face problems",
  "start-end-state": "Start/end state",
  "neighbor-continuity": "Neighboring-shot continuity",
  "dialogue-suitability": "Dialogue suitability",
};

/** Verdict for one check and for the rolled-up shot result. */
export const QC_VERDICTS = ["PASS", "FAIL", "REVIEW"] as const;

export type QcVerdict = (typeof QC_VERDICTS)[number];

export const qcVerdictSchema = z.enum(QC_VERDICTS);

/** How the multimodal reviewer saw the shot (spec §20 review route). */
export const QC_ROUTES = ["video-direct", "extracted-frames"] as const;

export type QcRoute = (typeof QC_ROUTES)[number];

export const qcRouteSchema = z.enum(QC_ROUTES);

/** One piece of evidence backing a check verdict. */
export const qcEvidenceSchema = z.object({
  /** What kind of artifact this evidence is. */
  kind: z.enum(["frame", "clip", "observation", "metric"]),
  /** Plain-language description; safe to show in reports. */
  description: z.string().min(1),
  /** Shot-relative timecode the evidence was taken at, in seconds. */
  timecodeSeconds: z.number().nonnegative().nullable().default(null),
  /** Path or asset ID of an extracted frame / clip backing this evidence. */
  frameRef: z.string().min(1).nullable().default(null),
  /** Measured value for `metric` evidence (e.g. hue delta), if any. */
  value: z
    .union([z.string().min(1), z.number(), z.boolean()])
    .nullable()
    .default(null),
});
export type QcEvidence = z.infer<typeof qcEvidenceSchema>;

/** Result of one spec §20 check against one shot. */
export const qcCheckResultSchema = z.object({
  checkId: qcCheckIdSchema,
  verdict: qcVerdictSchema,
  /** Every verdict carries at least one evidence item (see superRefine). */
  evidence: z.array(qcEvidenceSchema).min(1),
  /** Character this check was evaluated against, when character-bound. */
  characterId: z.string().min(1).nullable().default(null),
  /** Locked character version the check compared against, when known. */
  characterVersion: z.string().min(1).nullable().default(null),
  /** Short reviewer note (why the verdict); optional beyond evidence. */
  notes: z.string().nullable().default(null),
});
export type QcCheckResult = z.infer<typeof qcCheckResultSchema>;

/**
 * One complete per-shot QC result. `checks` must cover ALL 17 spec §20
 * check IDs exactly once — a partial QC pass is not a QC result.
 */
export const shotQcResultSchema = z
  .object({
    schemaVersion: z.literal(QC_RESULT_SCHEMA_VERSION),
    seriesId: z.string().min(1),
    episodeId: z.string().min(1),
    sceneId: z.string().min(1),
    shotId: z.string().min(1),
    /** Asset that was QC'd (see spec §19 asset manifest). */
    assetId: z.string().min(1).nullable().default(null),
    /** Review route: video direct or FFmpeg-extracted frames. */
    route: qcRouteSchema,
    /** Multimodal model (or human) that produced the verdicts. */
    reviewedBy: z.string().min(1),
    /** Per-check verdicts; completeness enforced below. */
    checks: z.array(qcCheckResultSchema),
    /** Rolled-up shot verdict (PASS only when every check passed). */
    verdict: qcVerdictSchema,
    /** ISO-8601 timestamps of QC start/completion. */
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    /** Generation attempt this QC result applies to (retry count, 0-based). */
    attempt: z.number().int().nonnegative().default(0),
    /** When this result supersedes an earlier result for the same shot. */
    supersedesResultId: z.string().min(1).nullable().default(null),
    /** Free-form production report note (spec §21); optional. */
    reportNotes: z.string().nullable().default(null),
  })
  .superRefine((result, ctx) => {
    const seen = new Set<string>();
    for (const check of result.checks) {
      if (seen.has(check.checkId)) {
        ctx.addIssue({
          code: "custom",
          path: ["checks"],
          message: `duplicate check result for "${check.checkId}"`,
        });
      }
      seen.add(check.checkId);
    }
    for (const checkId of QC_CHECK_IDS) {
      if (!seen.has(checkId)) {
        ctx.addIssue({
          code: "custom",
          path: ["checks"],
          message: `missing spec §20 check "${checkId}"`,
        });
      }
    }
  });
export type ShotQcResult = z.infer<typeof shotQcResultSchema>;

/**
 * Roll up per-check verdicts into the shot verdict (spec §18/§20):
 * any FAIL → FAIL; otherwise any REVIEW → REVIEW; otherwise PASS.
 */
export function rollupVerdict(checks: readonly QcCheckResult[]): QcVerdict {
  let sawReview = false;
  for (const check of checks) {
    if (check.verdict === "FAIL") return "FAIL";
    if (check.verdict === "REVIEW") sawReview = true;
  }
  return sawReview ? "REVIEW" : "PASS";
}

/** Constructor for a PASSED check with one observation. */
export function passedCheck(
  checkId: QcCheckId,
  description: string,
  options: {
    evidence?: QcEvidence[];
    characterId?: string | null;
    characterVersion?: string | null;
    notes?: string | null;
  } = {},
): QcCheckResult {
  return {
    checkId,
    verdict: "PASS",
    evidence: options.evidence ?? [
      { kind: "observation", description, timecodeSeconds: null, frameRef: null, value: null },
    ],
    characterId: options.characterId ?? null,
    characterVersion: options.characterVersion ?? null,
    notes: options.notes ?? null,
  };
}

/** Constructor for a FAILED check with one describing observation. */
export function failedCheck(
  checkId: QcCheckId,
  description: string,
  options: {
    evidence?: QcEvidence[];
    characterId?: string | null;
    characterVersion?: string | null;
    notes?: string | null;
  } = {},
): QcCheckResult {
  return {
    checkId,
    verdict: "FAIL",
    evidence: options.evidence ?? [
      { kind: "observation", description, timecodeSeconds: null, frameRef: null, value: null },
    ],
    characterId: options.characterId ?? null,
    characterVersion: options.characterVersion ?? null,
    notes: options.notes ?? null,
  };
}

/** Constructor for a check needing human review. */
export function reviewCheck(
  checkId: QcCheckId,
  description: string,
  options: {
    evidence?: QcEvidence[];
    characterId?: string | null;
    characterVersion?: string | null;
    notes?: string | null;
  } = {},
): QcCheckResult {
  return {
    checkId,
    verdict: "REVIEW",
    evidence: options.evidence ?? [
      { kind: "observation", description, timecodeSeconds: null, frameRef: null, value: null },
    ],
    characterId: options.characterId ?? null,
    characterVersion: options.characterVersion ?? null,
    notes: options.notes ?? null,
  };
}

/** Parse-and-narrow helper that throws a readable error on invalid results. */
export function parseShotQcResult(value: unknown): ShotQcResult {
  return shotQcResultSchema.parse(value);
}

/** Safe variant: returns the typed result or null when invalid. */
export function safeParseShotQcResult(value: unknown): ShotQcResult | null {
  const result = shotQcResultSchema.safeParse(value);
  return result.success ? result.data : null;
}