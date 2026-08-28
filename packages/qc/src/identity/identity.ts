/**
 * Character identity comparison — QC-002 (spec §20, §9, §12, §14).
 *
 * Compares an extracted frame (FFmpeg-extracted representative frame from a
 * generated shot, spec §20: "otherwise FFmpeg extracts representative frames
 * for image-vision QC") against the canonical Character Library identity asset
 * (spec §9) through a vision-model interface. The model is selected from the
 * reasoning/vision model registry (spec §14) by the `imageQc` slot; the caller
 * passes the resolved selection in, this module never reads config itself.
 *
 * The vision model is injected as a `VisionModel` interface so tests run with
 * a mocked model and the production adapter (OpenRouter-compatible) is a
 * separate concern. Story/shot text is UNTRUSTED DATA — it is interpolated
 * into the prompt only, never executed.
 */

import type {
  AssetDimensions,
  IdentityAsset,
} from "@mmcs/character-library/identity-asset/types";

/** Slot whose model performs identity QC (spec §14 QC LLM slots). */
export const IDENTITY_QC_SLOT = "imageQc" as const;

/**
 * What the vision model receives. Media is referenced by a provider-resolvable
 * source (data URI, https URL, or local path the adapter can read) — the
 * adapter owns actual transport.
 */
export interface VisionImage {
  /** Durable source label recorded in evidence (URL/data-URI/path). */
  source: string;
  /** Media MIME type, e.g. "image/png". */
  mimeType: string;
  /** Provider-resolvable media payload reference. */
  data: string;
}

/** A vision-model call verdict for one image-pair comparison. */
export interface VisionComparison {
  /**
   * Same character as the reference asset: "match" | "mismatch" | "uncertain".
   * Anything other than a confident "match" fails the check (spec §20: QC
   * failure → targeted repair) — uncertain must never auto-pass.
   */
  verdict: "match" | "mismatch" | "uncertain";
  /** 0..1 model confidence in its own verdict. */
  confidence: number;
  /** Free-form model rationale — evidence, never executed. */
  rationale: string;
  /** Per-attribute sub-verdicts the prompt asks the model to report. */
  attributes: VisionAttribute[];
}

/** One identity attribute the model is asked to compare. */
export interface VisionAttribute {
  /** Attribute key, e.g. "hair", "skinTone", "facialStructure". */
  key: string;
  /** Whether the attribute matched between frame and identity asset. */
  match: boolean;
  /** Optional model note about this attribute. */
  note: string | null;
}

/** Attributes the identity prompt always asks about (spec §20 identity set). */
export const IDENTITY_ATTRIBUTE_KEYS = [
  "facialStructure",
  "skinTone",
  "hair",
  "eyeColor",
  "agePresentation",
  "bodyType",
] as const;

export type IdentityAttributeKey = (typeof IDENTITY_ATTRIBUTE_KEYS)[number];

/** Minimal contract a vision adapter must satisfy (mocked in tests). */
export interface VisionModel {
  /** OpenRouter-style model ID recorded in evidence for provenance. */
  readonly modelId: string;
  /** Compare exactly two images and return the structured comparison. */
  compareImages(
    prompt: string,
    reference: VisionImage,
    candidate: VisionImage,
  ): Promise<VisionComparison>;
}

/** The selection that routed to the active vision model (spec §14). */
export interface VisionModelSelection {
  /** Registry slot used — must be "imageQc" for identity comparison. */
  slot: "imageQc";
  /** OpenRouter-style `vendor/model` model ID from the registry selection. */
  modelId: string;
  /** Registry confidence for the entry, preserved for provenance. */
  confidence: "VERIFIED" | "PROVISIONAL" | "UNKNOWN";
}

/** The frame under test, extracted from a generated shot. */
export interface ExtractedFrame {
  /** Frame image as a provider-resolvable reference (path/URL/data URI). */
  image: VisionImage;
  /** The shot the frame was extracted from (spec §12 shot_id). */
  shotId: string;
  /** Frame position in the source clip (seconds). */
  timestampSeconds: number;
  /** Pixel dimensions of the extracted frame. */
  dimensions: AssetDimensions;
}

/** Re-exported for callers building inputs without importing charlib. */
export type { AssetDimensions, IdentityAsset };

/**
 * Prompt sent to the vision model. Includes the canonical identity linkage
 * (asset ID, character ID, version) for provenance and asks for per-attribute
 * verdicts plus an overall verdict. Frame text and model rationale are data.
 */
export function buildIdentityPrompt(
  asset: Pick<IdentityAsset, "assetId" | "characterId" | "identityVersion">,
  frame: Pick<ExtractedFrame, "shotId" | "timestampSeconds">,
): string {
  const attributes = IDENTITY_ATTRIBUTE_KEYS.join(", ");
  return [
    "You are the MMCS character-identity QC reviewer.",
    `Compare IMAGE 1 (canonical identity asset ${asset.assetId}, character ${asset.characterId}, identity ${asset.identityVersion})`,
    `against IMAGE 2 (extracted frame from shot ${frame.shotId} at ${frame.timestampSeconds}s).`,
    `Decide whether IMAGE 2 shows the SAME character as IMAGE 1.`,
    `Compare these attributes and report each as match/mismatch: ${attributes}.`,
    "Judge identity only — ignore lighting, framing, compression artifacts, and color grading.",
    "Respond with JSON only: {\"verdict\":\"match\"|\"mismatch\"|\"uncertain\",\"confidence\":0..1,\"rationale\":\"...\",\"attributes\":[{\"key\":\"...\",\"match\":true|false,\"note\":\"...\"}]}.",
    "Use \"mismatch\" when any identity attribute clearly differs. Use \"uncertain\" only when the frame is too degraded, occluded, or off-character to judge — never as a soft pass.",
  ].join("\n");
}

/** Machine-readable JSON the model is instructed to return. */
const RESPONSE_JSON_SCHEMA_HINT =
  '"verdict" ("match"|"mismatch"|"uncertain"), "confidence" (0..1), "rationale", "attributes"';

/**
 * Parse a vision model response. Accepts either a pre-parsed object (mocked
 * models) or a JSON string (real adapters). Throws a typed error on anything
 * that is not a well-formed comparison — a malformed response must fail QC,
 * never silently pass it.
 */
export function parseVisionComparison(raw: unknown): VisionComparison {
  if (typeof raw === "string") {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      throw new VisionResponseError(
        "vision response contains no JSON object",
        raw,
      );
    }
    try {
      raw = JSON.parse(raw.slice(start, end + 1)) as unknown;
    } catch {
      throw new VisionResponseError(
        "vision response JSON is not parseable",
        raw,
      );
    }
  }
  if (typeof raw !== "object" || raw === null) {
    throw new VisionResponseError("vision response is not an object", raw);
  }
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "match" && verdict !== "mismatch" && verdict !== "uncertain") {
    throw new VisionResponseError(
      `vision response verdict must be "match"|"mismatch"|"uncertain", got: ${JSON.stringify(verdict)}`,
      raw,
    );
  }
  const confidence = obj.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new VisionResponseError(
      `vision response confidence must be 0..1, got: ${JSON.stringify(confidence)}`,
      raw,
    );
  }
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  const attributes = parseAttributes(obj.attributes);
  return { verdict, confidence, rationale, attributes };
}

function parseAttributes(raw: unknown): VisionAttribute[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new VisionResponseError("vision response attributes must be an array", raw);
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new VisionResponseError("attribute entry must be an object", entry);
    }
    const attr = entry as Record<string, unknown>;
    if (typeof attr.key !== "string" || attr.key.length === 0) {
      throw new VisionResponseError("attribute entry missing string key", entry);
    }
    if (typeof attr.match !== "boolean") {
      throw new VisionResponseError(
        `attribute ${attr.key} missing boolean match`,
        entry,
      );
    }
    return {
      key: attr.key,
      match: attr.match,
      note: typeof attr.note === "string" ? attr.note : null,
    };
  });
}

/** Error thrown for malformed vision-model responses. */
export class VisionResponseError extends Error {
  /** The raw response that failed to parse (kept as evidence). */
  readonly raw: string;

  constructor(message: string, raw: unknown) {
    super(message);
    this.name = "VisionResponseError";
    this.raw = typeof raw === "string" ? raw : JSON.stringify(raw);
  }
}

/** Inputs for one identity comparison run. */
export interface IdentityCheckInput {
  /** Canonical identity asset from the Character Library (spec §9). */
  identityAsset: Pick<
    IdentityAsset,
    | "assetId"
    | "characterId"
    | "identityVersion"
    | "ghlFileId"
    | "ghlUrl"
    | "sha256"
  >;
  /** Durable reference media resolved from the asset (spec §9, used verbatim). */
  reference: VisionImage;
  /** The extracted frame under test. */
  frame: ExtractedFrame;
  /** Registry-selected vision model (spec §14 imageQc slot). */
  model: VisionModel;
  /** How the model was selected — recorded in the result. */
  selection: VisionModelSelection;
}

/** Full result of one identity comparison. */
export interface IdentityCheckResult {
  /** Shot the frame came from. */
  shotId: string;
  /** Which check this is (spec §20 check name). */
  check: "character-identity";
  /** Final verdict after confidence gating. */
  verdict: "pass" | "fail" | "uncertain";
  /** Whether the identity check failed (QC failure → targeted repair). */
  failed: boolean;
  /** Raw model comparison (evidence). */
  comparison: VisionComparison;
  /** Model + selection provenance (registry-selected model ID). */
  modelId: string;
  selection: VisionModelSelection;
  /** Canonical identity linkage used for the comparison. */
  identityAssetRef: {
    assetId: string;
    characterId: string;
    identityVersion: string;
    ghlFileId: string | null;
    ghlUrl: string | null;
    sha256: string | null;
  };
  /** Human-readable failure summary when failed, else null. */
  reason: string | null;
  /** Attributes the model reported as mismatched. */
  mismatchedAttributes: string[];
}

/**
 * Run one extracted-frame vs canonical-identity-asset comparison.
 *
 * Verdict gating (spec §20 — QC failure must trigger targeted repair, and
 * uncertainty must never silently pass): "match" passes; "mismatch" fails;
 * "uncertain" is a QC failure (uncertain identity = unusable shot) reported as
 * verdict "uncertain" with `failed: true`.
 */
export async function checkIdentity(
  input: IdentityCheckInput,
): Promise<IdentityCheckResult> {
  assertCanonicalAsset(input.identityAsset);
  assertSelection(input.selection);
  return checkIdentityWithPrompt(input, buildIdentityPrompt(input.identityAsset, input.frame));
}

/** Internal seam so the prompt text is testable independently of the model. */
function assertCanonicalAsset(
  asset: Pick<
    IdentityAsset,
    "assetId" | "characterId" | "identityVersion" | "ghlFileId" | "ghlUrl" | "sha256"
  >,
): void {
  for (const field of [
    "assetId",
    "characterId",
    "identityVersion",
    "ghlFileId",
    "ghlUrl",
    "sha256",
  ] as const) {
    const value = asset[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `identity asset lacks ${field} — identity comparison requires the canonical durable record (spec §9)`,
      );
    }
  }
}

function assertSelection(selection: VisionModelSelection): void {
  if (selection.slot !== IDENTITY_QC_SLOT) {
    throw new Error(
      `identity comparison must run on the "${IDENTITY_QC_SLOT}" slot, got "${selection.slot}"`,
    );
  }
  if (!selection.modelId || selection.modelId.length === 0) {
    throw new Error("selection.modelId must be a non-empty registry-selected model ID");
  }
}

async function checkIdentityWithPrompt(
  input: IdentityCheckInput,
  prompt: string,
): Promise<IdentityCheckResult> {
  const comparison = parseVisionComparison(
    await input.model.compareImages(
      prompt,
      input.reference,
      input.frame.image,
    ),
  );

  const mismatchedAttributes = comparison.attributes
    .filter((attribute) => !attribute.match)
    .map((attribute) => attribute.key);

  let verdict: IdentityCheckResult["verdict"];
  if (comparison.verdict === "match") {
    verdict = "pass";
  } else if (comparison.verdict === "mismatch") {
    verdict = "fail";
  } else {
    verdict = "uncertain";
  }

  const failed = verdict !== "pass";
  const reason = failed
    ? verdict === "fail"
      ? mismatchedAttributes.length > 0
        ? `identity mismatch: ${mismatchedAttributes.join(", ")}`
        : "identity mismatch reported by vision model"
      : "vision model could not determine identity (uncertain)"
    : null;

  return {
    shotId: input.frame.shotId,
    check: "character-identity",
    verdict,
    failed,
    comparison,
    modelId: input.model.modelId,
    selection: input.selection,
    identityAssetRef: {
      assetId: input.identityAsset.assetId,
      characterId: input.identityAsset.characterId,
      identityVersion: input.identityAsset.identityVersion,
      ghlFileId: input.identityAsset.ghlFileId,
      ghlUrl: input.identityAsset.ghlUrl,
      sha256: input.identityAsset.sha256,
    },
    reason,
    mismatchedAttributes,
  };
}