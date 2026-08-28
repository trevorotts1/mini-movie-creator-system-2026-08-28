import { z } from "zod";

/**
 * Capability schema for the MMCS Model Capability Registry (runbook §16, §22;
 * spec subsystem 2). Every profile value is a plain capability value plus a
 * provenance/confidence tier — UNKNOWN is valid and must never be guessed.
 *
 * Separate registry kinds exist for reasoning/vision LLMs, image, video, voice,
 * and storage models. `incompatibleCombinations` names mode/input pairs that
 * the provider rejects when used together.
 */

/** Registry kinds — one registry per kind, never one mixed bag. */
export const CAPABILITY_KINDS = [
  "reasoning",
  "vision",
  "image",
  "video",
  "voice",
  "storage",
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const capabilityKindSchema = z.enum(CAPABILITY_KINDS);

/** Confidence tiers for every capability value, per runbook §16/§22. */
export const CONFIDENCE_LEVELS = ["VERIFIED", "PROVISIONAL", "UNKNOWN"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);

/** Prompt constraints for a model. null = unknown, never invented. */
export const promptCapabilitySchema = z.object({
  hardMaxCharacters: z.number().int().nonnegative().nullable(),
  recommendedMaxCharacters: z.number().int().nonnegative().nullable(),
  negativePromptSupported: z.boolean().nullable(),
});
export type PromptCapability = z.infer<typeof promptCapabilitySchema>;

/** Reference-input limits for a model. null = unknown, never invented. */
export const referencesCapabilitySchema = z.object({
  maxImages: z.number().int().nonnegative().nullable(),
  maxVideos: z.number().int().nonnegative().nullable(),
  maxAudio: z.number().int().nonnegative().nullable(),
  maxFiles: z.number().int().nonnegative().nullable(),
  allowedReferenceTypes: z.array(z.string().min(1)).nonempty().nullable(),
  firstFrame: z.boolean(),
  lastFrame: z.boolean(),
  firstLastFrame: z.boolean(),
  multimodalReferences: z.boolean(),
  /**
   * Mode/input pairs the provider rejects together, e.g.
   * "firstFrame+lastFrame" or "imageReference+videoReference". Empty array =
   * known to have none; UNKNOWN is expressed as null.
   */
  incompatibleCombinations: z.array(z.string().min(1)).nullable(),
});
export type ReferencesCapability = z.infer<typeof referencesCapabilitySchema>;

/** Generation-mode support flags, per runbook §22 modes block. */
export const modesCapabilitySchema = z.object({
  textToImage: z.boolean().nullable(),
  imageToImage: z.boolean().nullable(),
  textToVideo: z.boolean().nullable(),
  imageToVideo: z.boolean().nullable(),
  firstFrameToVideo: z.boolean().nullable(),
  firstLastFrameToVideo: z.boolean().nullable(),
  multimodalReferenceToVideo: z.boolean().nullable(),
  referenceVideoSupported: z.boolean().nullable(),
});
export type ModesCapability = z.infer<typeof modesCapabilitySchema>;

/** Output envelope for a model. null = unknown, never invented. */
export const outputCapabilitySchema = z.object({
  minDurationSeconds: z.number().nonnegative().nullable(),
  maxDurationSeconds: z.number().positive().nullable(),
  durationsSeconds: z.array(z.number().positive()).nullable(),
  resolutions: z.array(z.string().min(1)).nullable(),
  aspectRatios: z.array(z.string().min(1)).nullable(),
  audioGenerationSupported: z.boolean().nullable(),
});
export type OutputCapability = z.infer<typeof outputCapabilitySchema>;

/** Hard input constraints (mutually exclusive inputs, parameter conflicts, size limits). */
export const constraintsCapabilitySchema = z.object({
  mutuallyExclusiveInputs: z.array(z.array(z.string().min(1))).nullable(),
  incompatibleParameters: z
    .array(z.object({ parameter: z.string().min(1), conflictsWith: z.array(z.string().min(1)) }))
    .nullable(),
  fileSizeLimits: z
    .array(z.object({ input: z.string().min(1), maxBytes: z.number().int().positive() }))
    .nullable(),
});
export type ConstraintsCapability = z.infer<typeof constraintsCapabilitySchema>;

/** Pricing for a model. null unit/amount = unknown, never invented. */
export const pricingCapabilitySchema = z.object({
  unit: z.string().min(1).nullable(),
  amount: z.number().nonnegative().nullable(),
  currency: z.string().length(3).default("USD"),
  quota: z.string().min(1).nullable(),
  overage: z.string().min(1).nullable(),
});
export type PricingCapability = z.infer<typeof pricingCapabilitySchema>;

/**
 * Full capability profile for one provider model. `kind` selects which
 * registry the profile lives in (reasoning/vision/image/video/voice/storage).
 */
export const mediaModelCapabilitySchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  modelFamily: z.string().min(1).nullable().default(null),
  modelType: z.string().min(1).nullable().default(null),
  kind: capabilityKindSchema,
  /** ISO-8601 timestamp of the last human verification of these values. */
  lastVerifiedAt: z.string().datetime({ offset: true }),
  sourceUrls: z.array(z.string().url()),
  confidence: confidenceSchema,
  prompt: promptCapabilitySchema,
  references: referencesCapabilitySchema,
  modes: modesCapabilitySchema,
  output: outputCapabilitySchema,
  constraints: constraintsCapabilitySchema,
  pricing: pricingCapabilitySchema,
});
export type MediaModelCapability = z.infer<typeof mediaModelCapabilitySchema>;

/** A versioned snapshot of one kind's registry (runbook §22: versioned). */
export const capabilityRegistrySchema = z.object({
  version: z.number().int().positive(),
  kind: capabilityKindSchema,
  updatedAt: z.string().datetime({ offset: true }),
  entries: z.array(mediaModelCapabilitySchema),
});
export type CapabilityRegistry = z.infer<typeof capabilityRegistrySchema>;

/**
 * Convenience constructors: every sub-block starts UNKNOWN so builders cannot
 * accidentally ship invented numbers; fields are then filled from sources.
 */
export function unknownPromptCapability(): PromptCapability {
  return {
    hardMaxCharacters: null,
    recommendedMaxCharacters: null,
    negativePromptSupported: null,
  };
}

export function unknownReferencesCapability(): ReferencesCapability {
  return {
    maxImages: null,
    maxVideos: null,
    maxAudio: null,
    maxFiles: null,
    allowedReferenceTypes: null,
    firstFrame: false,
    lastFrame: false,
    firstLastFrame: false,
    multimodalReferences: false,
    incompatibleCombinations: null,
  };
}

export function unknownModesCapability(): ModesCapability {
  return {
    textToImage: null,
    imageToImage: null,
    textToVideo: null,
    imageToVideo: null,
    firstFrameToVideo: null,
    firstLastFrameToVideo: null,
    multimodalReferenceToVideo: null,
    referenceVideoSupported: null,
  };
}

export function unknownOutputCapability(): OutputCapability {
  return {
    minDurationSeconds: null,
    maxDurationSeconds: null,
    durationsSeconds: null,
    resolutions: null,
    aspectRatios: null,
    audioGenerationSupported: null,
  };
}

export function unknownConstraintsCapability(): ConstraintsCapability {
  return {
    mutuallyExclusiveInputs: null,
    incompatibleParameters: null,
    fileSizeLimits: null,
  };
}

export function unknownPricingCapability(): PricingCapability {
  return { unit: null, amount: null, currency: "USD", quota: null, overage: null };
}

/** Parse-and-narrow helper that throws a readable error on invalid profiles. */
export function parseMediaModelCapability(value: unknown): MediaModelCapability {
  return mediaModelCapabilitySchema.parse(value);
}

/** Safe variant: returns the typed profile or null when invalid. */
export function safeParseMediaModelCapability(
  value: unknown,
): MediaModelCapability | null {
  const result = mediaModelCapabilitySchema.safeParse(value);
  return result.success ? result.data : null;
}