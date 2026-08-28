/**
 * CAP-004 — Reference-count validator (Model Capability Registry).
 *
 * Pre-flight reference-count validation per runbook §16: every generation
 * request carries the capability profile of the exact model it targets, and
 * the number of reference images/videos/audio is compared against that
 * profile BEFORE any provider call is made.
 *
 * Facts encoded (runbook §16, §22, §26.4; UNKNOWN stays null — never a
 * guessed number):
 *   - Wan 3.0 via Kie baseline: up to 10 reference images, up to 5 reference
 *     videos, up to 5 reference audio (PROVISIONAL until live-verified).
 *   - `null` maximum = UNKNOWN limit → not enforced. Per runbook §16
 *     "UNKNOWN is valid. Never invent a hard limit because another model
 *     has one" — an UNKNOWN reference limit never rejects a request.
 *   - The profile is a structural input ({@link ReferenceCountProfile}), so
 *     the validator works against any profile shape that exposes the
 *     reference maxima (including the CAP-001 MediaModelCapability profile).
 *
 * Pure module — no I/O, no fetch. The adapter composes the request, the
 * client sends it; this validator runs first and refuses over-limit
 * requests so paid provider calls never happen on a doomed payload.
 */

/**
 * The reference-limit slice of a capability profile. Every field nullable:
 * null = limit unknown for this model, never enforced (UNKNOWN stays UNKNOWN).
 */
export interface ReferenceCountProfile {
  /** Max reference images allowed by the model, or null when unknown. */
  maxImages: number | null;
  /** Max reference videos allowed by the model, or null when unknown. */
  maxVideos: number | null;
  /** Max reference audio files allowed by the model, or null when unknown. */
  maxAudio: number | null;
  /** Max TOTAL reference files (all kinds) allowed, or null when unknown. */
  maxFiles: number | null;
}

/** Reference counts of one request, per input type. */
export interface ReferenceCounts {
  /** Number of reference images in the request. */
  images: number;
  /** Number of reference videos in the request. */
  videos: number;
  /** Number of reference audio files in the request. */
  audio: number;
}

/** A single reference-count validation defect. */
export interface ReferenceCountIssue {
  /** Request input the defect belongs to ("images" | "videos" | "audio" | "files" | "profile"). */
  field: string;
  /** Machine-readable rule identifier (stable for downstream tests/routing). */
  code: string;
  /** Human-readable explanation; safe to log. */
  message: string;
}

/** Thrown by {@link validateReferenceCounts} on any pre-flight failure. */
export class ReferenceCountValidationError extends Error {
  readonly issues: readonly ReferenceCountIssue[];
  constructor(issues: readonly ReferenceCountIssue[]) {
    super(
      `Reference counts failed validation (${issues.length} issue(s)): ${issues
        .map((i) => `[${i.code}] ${i.field}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "ReferenceCountValidationError";
    this.issues = issues;
  }
}

/** Wan 3.0 (via Kie) reference limits — runbook §26.4 research baseline. */
export const WAN_REFERENCE_LIMITS: ReferenceCountProfile = {
  maxImages: 10,
  maxVideos: 5,
  maxAudio: 5,
  maxFiles: null,
};

/** True when a count is a usable non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Per-input limit checks, iterated deterministically. */
const COUNT_FIELDS: ReadonlyArray<{
  key: keyof ReferenceCounts;
  limitKey: keyof ReferenceCountProfile;
}> = [
  { key: "images", limitKey: "maxImages" },
  { key: "videos", limitKey: "maxVideos" },
  { key: "audio", limitKey: "maxAudio" },
];

/**
 * Collect every reference-count violation for `counts` against `profile`.
 * Returns [] when every count is within its profile limit. A null limit
 * (UNKNOWN) never produces an issue; a malformed count (negative or
 * non-integer) and a malformed profile limit always do.
 */
export function collectReferenceCountIssues(
  profile: ReferenceCountProfile,
  counts: ReferenceCounts,
): ReferenceCountIssue[] {
  const issues: ReferenceCountIssue[] = [];

  for (const { key, limitKey } of COUNT_FIELDS) {
    const count = counts[key];
    const limit = profile[limitKey];

    // A malformed count is a caller bug regardless of what the profile says.
    const countValid = typeof count === "number" && Number.isInteger(count) && count >= 0;
    if (!countValid) {
      issues.push({
        field: key,
        code: "REFERENCE_COUNT_INVALID",
        message: `${key} count must be a non-negative integer (got ${String(count)})`,
      });
    }

    // null/undefined limit = UNKNOWN → never enforced, never a guessed number.
    if (limit === null || limit === undefined) continue;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
      issues.push({
        field: "profile",
        code: "INVALID_PROFILE_LIMIT",
        message: `capability profile ${limitKey} must be a non-negative integer or null (got ${String(limit)})`,
      });
      continue;
    }

    if (countValid && count > limit) {
      issues.push({
        field: key,
        code: "TOO_MANY_REFERENCES",
        message: `${key} allows at most ${limit} reference(s) for this model (got ${count})`,
      });
    }
  }

  const maxFiles = profile.maxFiles;
  if (maxFiles !== null && maxFiles !== undefined) {
    if (typeof maxFiles !== "number" || !Number.isInteger(maxFiles) || maxFiles < 0) {
      issues.push({
        field: "profile",
        code: "INVALID_PROFILE_LIMIT",
        message: `capability profile maxFiles must be a non-negative integer or null (got ${String(maxFiles)})`,
      });
    } else {
      const total = COUNT_FIELDS.reduce((sum, { key }) => {
        const c = counts[key];
        return typeof c === "number" && Number.isInteger(c) && c >= 0 ? sum + c : sum;
      }, 0);
      if (total > maxFiles) {
        issues.push({
          field: "files",
          code: "TOO_MANY_REFERENCE_FILES",
          message: `this model allows at most ${maxFiles} total reference files (got ${total})`,
        });
      }
    }
  }

  return issues;
}

/**
 * Pre-flight validate reference counts against the target model's capability
 * profile. Throws {@link ReferenceCountValidationError} listing EVERY
 * violation found. Call BEFORE any provider submit — an over-limit payload
 * must never reach a paid generation call.
 */
export function validateReferenceCounts(
  profile: ReferenceCountProfile,
  counts: ReferenceCounts,
): void {
  const issues = collectReferenceCountIssues(profile, counts);
  if (issues.length > 0) {
    throw new ReferenceCountValidationError(issues);
  }
}

/**
 * Convenience: derive {@link ReferenceCounts} from the URL lists a request
 * already carries (e.g. Wan `reference_image_urls` / `_video_urls` /
 * `_audio_urls`). Undefined lists count as 0.
 */
export function countReferences(
  imageUrls?: readonly unknown[],
  videoUrls?: readonly unknown[],
  audioUrls?: readonly unknown[],
): ReferenceCounts {
  return {
    images: imageUrls?.length ?? 0,
    videos: videoUrls?.length ?? 0,
    audio: audioUrls?.length ?? 0,
  };
}