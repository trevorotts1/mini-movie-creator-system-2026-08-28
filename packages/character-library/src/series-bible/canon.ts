/**
 * Canon-at-time resolution and Gate 6 canon-change lifecycle (spec §10).
 *
 * Canon mutates only through versioned CanonChange records. Approval
 * assigns a sequential canonVersion; any historical episode read replays
 * the approved changes up to that episode, so "Monica moved apartments in
 * S01E09" never leaks back into an S01E05 render.
 */

import type {
  CanonChange,
  CanonMutation,
  CanonState,
  CharacterId,
  EpisodeCode,
  SeriesBible,
} from "./types.js";

/** Error thrown on invalid series-bible operations. */
export class SeriesBibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeriesBibleError";
  }
}

/** Parse "S<season>E<episode>" into a sortable number (S01E09 → 10009).
 * Digits not zero-padded are accepted and normalized (S1E9 → 10009). */
export function episodeNumber(episode: EpisodeCode): number {
  const match = /^S(\d+)E(\d+)$/.exec(episode);
  if (!match) {
    throw new SeriesBibleError(
      `episode must match S<season>E<episode>, got "${episode}"`,
    );
  }
  return Number(match[1]) * 10000 + Number(match[2]);
}

/** The canon of a fresh series bible, before any approved change. */
export function baseCanon(): CanonState {
  return {
    premise: "",
    worldRules: [],
    characters: [],
    relationships: [],
    locations: [],
    wardrobe: [],
    props: [],
    visualStyle: { styleGuide: "", tags: [] },
    cameraLanguage: { grammar: [] },
    voiceProfiles: [],
    characterEvents: [],
    plotThreads: [],
  };
}

/**
 * Apply one canon mutation, in place. Called in listed order when a change
 * is approved, and identically during canon-at-time replays, so a replay
 * and the live mutation path can never diverge.
 *
 * Every pushed payload is cloned: mutation objects belong to their
 * CanonChange record, and a replay must never mutate — or share structure
 * with — the ledger's copy.
 */
export function applyCanonMutation(
  canon: CanonState,
  mutation: CanonMutation,
): void {
  switch (mutation.op) {
    case "set_premise":
      canon.premise = mutation.premise;
      return;
    case "add_world_rule": {
      const rule = structuredClone(mutation.rule);
      if (canon.worldRules.some((r) => r.ruleId === rule.ruleId)) {
        throw new SeriesBibleError(`world rule already in canon: ${rule.ruleId}`);
      }
      canon.worldRules.push(rule);
      return;
    }
    case "retire_world_rule":
      canon.worldRules = canon.worldRules.filter(
        (r) => r.ruleId !== mutation.ruleId,
      );
      return;
    case "add_character": {
      const link = structuredClone(mutation.link);
      if (
        canon.characters.some((c) => c.characterId === link.characterId)
      ) {
        throw new SeriesBibleError(
          `character already in series cast: ${link.characterId}`,
        );
      }
      canon.characters.push(link);
      return;
    }
    case "remove_character":
      canon.characters = canon.characters.filter(
        (c) => c.characterId !== mutation.characterId,
      );
      return;
    case "record_character_event":
      canon.characterEvents.push(structuredClone(mutation.event));
      return;
    case "add_relationship":
      canon.relationships.push(structuredClone(mutation.relationship));
      return;
    case "add_location": {
      const location = structuredClone(mutation.location);
      if (canon.locations.some((l) => l.locationId === location.locationId)) {
        throw new SeriesBibleError(
          `location already in canon: ${location.locationId}`,
        );
      }
      canon.locations.push(location);
      return;
    }
    case "retire_location":
      canon.locations = canon.locations.filter(
        (l) => l.locationId !== mutation.locationId,
      );
      return;
    case "add_wardrobe":
      canon.wardrobe.push(structuredClone(mutation.wardrobe));
      return;
    case "add_prop": {
      const prop = structuredClone(mutation.prop);
      if (canon.props.some((p) => p.propId === prop.propId)) {
        throw new SeriesBibleError(`prop already in canon: ${prop.propId}`);
      }
      canon.props.push(prop);
      return;
    }
    case "set_visual_style":
      canon.visualStyle = structuredClone(mutation.style);
      return;
    case "set_camera_language":
      canon.cameraLanguage = structuredClone(mutation.camera);
      return;
    case "add_voice_profile": {
      const profile = structuredClone(mutation.profile);
      if (
        canon.voiceProfiles.some((v) => v.characterId === profile.characterId)
      ) {
        throw new SeriesBibleError(
          `voice profile already bound in canon: ${profile.characterId}`,
        );
      }
      canon.voiceProfiles.push(profile);
      return;
    }
    case "open_plot_thread": {
      const thread = structuredClone(mutation.thread);
      if (canon.plotThreads.some((t) => t.threadId === thread.threadId)) {
        throw new SeriesBibleError(
          `plot thread already open: ${thread.threadId}`,
        );
      }
      canon.plotThreads.push(thread);
      return;
    }
    case "resolve_plot_thread": {
      const thread = canon.plotThreads.find(
        (t) => t.threadId === mutation.threadId,
      );
      if (!thread) {
        throw new SeriesBibleError(
          `cannot resolve unknown plot thread: ${mutation.threadId}`,
        );
      }
      thread.status = "resolved";
      thread.resolvedEpisode = mutation.resolvedEpisode;
      thread.resolution = mutation.resolution;
      return;
    }
  }
}

/** Next canon version number: highest assigned + 1 (1-based). */
function nextCanonVersion(bible: SeriesBible): number {
  let max = 0;
  for (const change of bible.canonChanges) {
    if (change.canonVersion !== undefined && change.canonVersion > max) {
      max = change.canonVersion;
    }
  }
  return max + 1;
}

/**
 * Approve a proposed canon change (Gate 6 sign-off happened outside this
 * call). The bible's `base` is never mutated: canon is always the replay of
 * approved changes, so approval only (1) validates the mutations against
 * the canon that would result — throwing keeps the change PROPOSED — and
 * (2) stamps APPROVED + sequential canonVersion + decidedAt.
 */
export function approveCanonChange(
  bible: SeriesBible,
  changeId: string,
  decidedAt: string,
): CanonChange {
  const change = bible.canonChanges.find((c) => c.changeId === changeId);
  if (!change) {
    throw new SeriesBibleError(`unknown canon change: ${changeId}`);
  }
  if (change.status !== "PROPOSED") {
    throw new SeriesBibleError(
      `canon change ${changeId} already decided (${change.status})`,
    );
  }
  const scratch = currentCanon(bible);
  for (const mutation of change.mutations) {
    applyCanonMutation(scratch, mutation);
  }
  change.status = "APPROVED";
  change.decidedAt = decidedAt;
  change.canonVersion = nextCanonVersion(bible);
  return change;
}

/**
 * Live canon: replay of every APPROVED change onto the pristine base,
 * regardless of effective episode. This is the canon future episodes
 * produce against; historical reads use {@link canonAtEpisode}.
 */
export function currentCanon(bible: SeriesBible): CanonState {
  const canon: CanonState = structuredClone(bible.base);
  const approved = bible.canonChanges
    .filter((c) => c.status === "APPROVED" && c.canonVersion !== undefined)
    .sort((a, b) => (a.canonVersion ?? 0) - (b.canonVersion ?? 0));
  for (const change of approved) {
    for (const mutation of change.mutations) {
      applyCanonMutation(canon, mutation);
    }
  }
  return canon;
}

/**
 * Reject a proposed canon change: nothing touches canon. Terminal — the
 * change stays in the ledger as REJECTED and can never be re-decided.
 */
export function rejectCanonChange(
  bible: SeriesBible,
  changeId: string,
  decidedAt: string,
): CanonChange {
  const change = bible.canonChanges.find((c) => c.changeId === changeId);
  if (!change) {
    throw new SeriesBibleError(`unknown canon change: ${changeId}`);
  }
  if (change.status !== "PROPOSED") {
    throw new SeriesBibleError(
      `canon change ${changeId} already decided (${change.status})`,
    );
  }
  change.status = "REJECTED";
  change.decidedAt = decidedAt;
  return change;
}

/**
 * Canon-at-time: rebuild the canon as it stood at the END of the queried
 * episode by replaying approved changes with effectiveEpisode <= episode in
 * canonVersion order. No approved change whose effective episode is later —
 * or still PROPOSED/REJECTED — affects the result.
 *
 * The bible's own `base` is NEVER returned directly; callers always get an
 * independent replay, so reads can never mutate live canon. Returns a deep
 * structural copy.
 */
export function canonAtEpisode(
  bible: SeriesBible,
  episode: EpisodeCode,
): CanonState {
  const query = episodeNumber(episode);
  const replayable = bible.canonChanges
    .filter(
      (c) =>
        c.status === "APPROVED" &&
        c.canonVersion !== undefined &&
        episodeNumber(c.effectiveEpisode) <= query,
    )
    .sort((a, b) => (a.canonVersion ?? 0) - (b.canonVersion ?? 0));
  const canon: CanonState = structuredClone(bible.base);
  for (const change of replayable) {
    for (const mutation of change.mutations) {
      applyCanonMutation(canon, mutation);
    }
  }
  return canon;
}

/**
 * Canon-at-time for a character: filter the full canon-at-episode down to
 * everything recorded about one character, in one shape. This is the read
 * the shot planners (spec §7) consume to resolve the active identity /
 * wardrobe / event state for an episode's continuity point.
 */
export function characterCanonAtEpisode(
  bible: SeriesBible,
  characterId: CharacterId,
  episode: EpisodeCode,
): {
  inCast: boolean;
  events: Array<{ event: string; effectiveEpisode: string }>;
  wardrobe: string[];
  voiceProfileId?: string;
} {
  const canon = canonAtEpisode(bible, episode);
  return {
    inCast: canon.characters.some((c) => c.characterId === characterId),
    events: canon.characterEvents
      .filter((e) => e.characterId === characterId)
      .map((e) => ({ event: e.event, effectiveEpisode: e.effectiveEpisode })),
    wardrobe: canon.wardrobe
      .filter((w) => w.characterId === characterId)
      .map((w) => w.wardrobeVersion),
    voiceProfileId: canon.voiceProfiles.find(
      (v) => v.characterId === characterId,
    )?.voiceProfileId,
  };
}