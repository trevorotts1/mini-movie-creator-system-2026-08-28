/**
 * Fish Audio voice profile — the canonical per-character voice record.
 *
 * Spec §30 (runbook PART II): "Canonical character voice profile stores:
 * character ID; Fish voice/reference ID; model; pace; emotion/style guidance;
 * pronunciation dictionary; important proper nouns; test sample status;
 * approval status. Recurring characters never randomly change voices across
 * episodes. Dialogue generated as separate durable asset so replacing a video
 * clip does not force voice regeneration."
 *
 * This module owns ONLY the data shape + validation. Persistence lives in
 * store.ts; synthesis lives in the Fish client (FISH-001).
 */

/** Fish Audio synthesis model identifier (e.g. "s2-pro", "s1"). Config-driven;
 * never hard-coded at call sites. */
export type FishModel = string;

/** Pace of synthesized speech. */
export type FishPace =
  | "very_slow"
  | "slow"
  | "normal"
  | "fast"
  | "very_fast";

/** A single pronunciation override: how a word/phrase is spoken. */
export interface FishPronunciation {
  /** The written word or phrase this entry overrides. */
  term: string;
  /** The spoken/phonetic replacement (IPA, respelling, or Fish dict format). */
  pronunciation: string;
}

/**
 * Test-sample status for a voice profile. A profile is not production-safe
 * until a test sample has been generated for it and reviewed.
 */
export type FishTestSampleStatus =
  | "none"
  | "pending"
  | "generated"
  | "approved"
  | "rejected";

/** Approval status mirroring the character-library asset states (spec §17.5). */
export type FishProfileApprovalStatus =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED";

/** The canonical character voice profile (spec §30 fields). */
export interface FishVoiceProfile {
  /** Stable character ID this profile is bound to (e.g. "CHAR_MONICA_BENNETT_001").
   * Never a display-name key. */
  characterId: string;
  /** Fish Audio voice ID or reference ID used for synthesis. */
  fishVoiceId: string;
  /** Fish Audio model used with this profile. Config-driven, never inlined. */
  model: FishModel;
  /** Speech pace. */
  pace: FishPace;
  /** Free-form emotion/style guidance passed to the synthesis request. */
  emotionStyle: string;
  /** Pronunciation dictionary entries applied at synthesis time. */
  pronunciationDictionary: FishPronunciation[];
  /** Important proper nouns that must be pronounced correctly (names, brands,
   * invented series terms). Kept separate from the dictionary as a checklist. */
  importantProperNouns: string[];
  /** Test-sample lifecycle status. */
  testSampleStatus: FishTestSampleStatus;
  /** Asset ID of the generated test sample, when one exists. */
  testSampleAssetId?: string;
  /** Approval state. Only APPROVED/CANONICAL profiles are auto-reused. */
  approvalStatus: FishProfileApprovalStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /** Monotonic version, incremented on every mutation of voice-defining
   * fields. Recurring characters keep one stable voice; a version bump is a
   * deliberate, audited change — never random drift. */
  version: number;
}

/** Fields a caller may set when creating a profile. */
export type FishVoiceProfileCreateInput = Partial<
  Pick<
    FishVoiceProfile,
    | "fishVoiceId"
    | "model"
    | "pace"
    | "emotionStyle"
    | "pronunciationDictionary"
    | "importantProperNouns"
    | "testSampleStatus"
    | "approvalStatus"
  >
>;

/** Fields a caller may update. `characterId` is immutable — the profile is
 * bound to its character for life; move to a new character = new profile. */
export type FishVoiceProfileUpdateInput = Partial<
  Pick<
    FishVoiceProfile,
    | "fishVoiceId"
    | "model"
    | "pace"
    | "emotionStyle"
    | "pronunciationDictionary"
    | "importantProperNouns"
    | "testSampleStatus"
    | "testSampleAssetId"
    | "approvalStatus"
  >
>;

const PACES: readonly FishPace[] = [
  "very_slow",
  "slow",
  "normal",
  "fast",
  "very_fast",
];

const TEST_SAMPLE_STATUSES: readonly FishTestSampleStatus[] = [
  "none",
  "pending",
  "generated",
  "approved",
  "rejected",
];

const APPROVAL_STATUSES: readonly FishProfileApprovalStatus[] = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "CANONICAL",
  "RETIRED",
];

const CHARACTER_ID_RE = /^[A-Z][A-Z0-9_]*$/;

/** True when the string looks like a stable MMCS character ID
 * (CHAR_MONICA_BENNETT_001 style — uppercase, underscore-separated). */
export function isValidCharacterId(id: string): boolean {
  return CHARACTER_ID_RE.test(id);
}

/** Validate + normalize a pronunciation entry. Throws on a bad entry. */
function normalizePronunciation(raw: FishPronunciation, index: number): FishPronunciation {
  const term = raw.term?.trim();
  const pronunciation = raw.pronunciation?.trim();
  if (!term) {
    throw new Error(`FishVoiceProfile pronunciation[${index}].term is required`);
  }
  if (!pronunciation) {
    throw new Error(`FishVoiceProfile pronunciation[${index}].pronunciation is required`);
  }
  return { term, pronunciation };
}

/** Validate + default the create input into a full profile. Throws on invalid
 * input; never silently repairs. */
export function createVoiceProfile(
  characterId: string,
  input: FishVoiceProfileCreateInput = {},
): FishVoiceProfile {
  if (!isValidCharacterId(characterId)) {
    throw new Error(
      `FishVoiceProfile characterId must be a stable MMCS ID (CHAR_*_001 style), got: ${JSON.stringify(characterId)}`,
    );
  }
  const fishVoiceId = input.fishVoiceId?.trim();
  if (!fishVoiceId) {
    throw new Error("FishVoiceProfile.fishVoiceId is required");
  }
  const model = input.model?.trim();
  if (!model) {
    throw new Error("FishVoiceProfile.model is required (config-driven Fish model ID)");
  }
  const pace = input.pace ?? "normal";
  if (!PACES.includes(pace)) {
    throw new Error(`FishVoiceProfile.pace must be one of ${PACES.join(", ")}`);
  }
  const testSampleStatus = input.testSampleStatus ?? "none";
  if (!TEST_SAMPLE_STATUSES.includes(testSampleStatus)) {
    throw new Error(
      `FishVoiceProfile.testSampleStatus must be one of ${TEST_SAMPLE_STATUSES.join(", ")}`,
    );
  }
  const approvalStatus = input.approvalStatus ?? "DRAFT";
  if (!APPROVAL_STATUSES.includes(approvalStatus)) {
    throw new Error(`FishVoiceProfile.approvalStatus must be one of ${APPROVAL_STATUSES.join(", ")}`);
  }
  const now = new Date().toISOString();
  return {
    characterId,
    fishVoiceId,
    model,
    pace,
    emotionStyle: input.emotionStyle?.trim() ?? "",
    pronunciationDictionary: (input.pronunciationDictionary ?? []).map(normalizePronunciation),
    importantProperNouns: (input.importantProperNouns ?? []).map((n) => n.trim()),
    testSampleStatus,
    approvalStatus,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

/** Validate + apply an update onto an existing profile. Returns a NEW profile
 * object (immutable style); bumps `version` and `updatedAt` when anything
 * voice-defining changed. Throws on invalid input or an attempt to change
 * `characterId` (callers cannot pass one — enforced by the input type; this
 * guard also covers raw persisted records). */
export function updateVoiceProfile(
  existing: FishVoiceProfile,
  patch: FishVoiceProfileUpdateInput,
): FishVoiceProfile {
  if ("characterId" in (patch as Record<string, unknown>)) {
    throw new Error("FishVoiceProfile.characterId is immutable — create a new profile instead");
  }
  const next: FishVoiceProfile = { ...existing, pronunciationDictionary: [...existing.pronunciationDictionary], importantProperNouns: [...existing.importantProperNouns] };

  if (patch.fishVoiceId !== undefined) {
    const v = patch.fishVoiceId.trim();
    if (!v) throw new Error("FishVoiceProfile.fishVoiceId cannot be blank");
    next.fishVoiceId = v;
  }
  if (patch.model !== undefined) {
    const v = patch.model.trim();
    if (!v) throw new Error("FishVoiceProfile.model cannot be blank");
    next.model = v;
  }
  if (patch.pace !== undefined) {
    if (!PACES.includes(patch.pace)) {
      throw new Error(`FishVoiceProfile.pace must be one of ${PACES.join(", ")}`);
    }
    next.pace = patch.pace;
  }
  if (patch.emotionStyle !== undefined) {
    next.emotionStyle = patch.emotionStyle.trim();
  }
  if (patch.pronunciationDictionary !== undefined) {
    next.pronunciationDictionary = patch.pronunciationDictionary.map(normalizePronunciation);
  }
  if (patch.importantProperNouns !== undefined) {
    next.importantProperNouns = patch.importantProperNouns.map((n) => n.trim());
  }
  if (patch.testSampleStatus !== undefined) {
    if (!TEST_SAMPLE_STATUSES.includes(patch.testSampleStatus)) {
      throw new Error(
        `FishVoiceProfile.testSampleStatus must be one of ${TEST_SAMPLE_STATUSES.join(", ")}`,
      );
    }
    next.testSampleStatus = patch.testSampleStatus;
  }
  if (patch.testSampleAssetId !== undefined) {
    const v = patch.testSampleAssetId.trim();
    if (!v) throw new Error("FishVoiceProfile.testSampleAssetId cannot be blank");
    next.testSampleAssetId = v;
    if (next.testSampleStatus === "none") {
      // An asset arriving implies the sample exists; track it.
      next.testSampleStatus = "generated";
    }
  }
  if (patch.approvalStatus !== undefined) {
    if (!APPROVAL_STATUSES.includes(patch.approvalStatus)) {
      throw new Error(`FishVoiceProfile.approvalStatus must be one of ${APPROVAL_STATUSES.join(", ")}`);
    }
    next.approvalStatus = patch.approvalStatus;
  }

  const changed =
    next.fishVoiceId !== existing.fishVoiceId ||
    next.model !== existing.model ||
    next.pace !== existing.pace ||
    next.emotionStyle !== existing.emotionStyle ||
    JSON.stringify(next.pronunciationDictionary) !== JSON.stringify(existing.pronunciationDictionary) ||
    JSON.stringify(next.importantProperNouns) !== JSON.stringify(existing.importantProperNouns) ||
    next.testSampleStatus !== existing.testSampleStatus ||
    next.testSampleAssetId !== existing.testSampleAssetId ||
    next.approvalStatus !== existing.approvalStatus;

  if (changed) {
    next.version = existing.version + 1;
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

/** A profile is production-safe for auto-reuse only when approved AND its
 * test sample has been approved. Enforced wherever synthesis is planned. */
export function isProductionReady(profile: FishVoiceProfile): boolean {
  return (
    (profile.approvalStatus === "APPROVED" || profile.approvalStatus === "CANONICAL") &&
    profile.testSampleStatus === "approved"
  );
}