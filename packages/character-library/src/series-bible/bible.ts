/**
 * Series bible construction + episode-record appends (spec §10).
 *
 * Canon sections are mutated exclusively through approved CanonChanges
 * (Gate 6, see canon.ts). Creation seeds the starting canon; episode
 * summaries and timeline events are append-only factual records, written as
 * episodes complete — they never need Gate 6.
 */

import { baseCanon, SeriesBibleError } from "./canon.js";
import type {
  CanonChange,
  CanonState,
  EpisodeSummary,
  SeriesBible,
  TimelineEvent,
} from "./types.js";

/** Options for {@link createSeriesBible}. */
export interface CreateSeriesBibleOptions {
  /** Stable series ID, e.g. "SER_HARTWELL_HEIGHTS_001". */
  seriesId: string;
  /** Display title. */
  title: string;
  /** Starting premise; may be empty and set later via a canon change. */
  premise?: string;
}

/** Create a fresh series bible. `base` is the immutable replay origin. */
export function createSeriesBible(
  options: CreateSeriesBibleOptions,
): SeriesBible {
  if (options.seriesId.length === 0) {
    throw new SeriesBibleError("seriesId must be non-empty");
  }
  const base: CanonState = baseCanon();
  base.premise = options.premise ?? "";
  return {
    seriesId: options.seriesId,
    title: options.title,
    base,
    canonChanges: [],
    episodeSummaries: [],
    timeline: [],
  };
}

/**
 * Stage a proposed canon change at the end of an episode (spec §10
 * "Proposed Canon Changes review"). Does NOT touch canon — approval does.
 */
export function proposeCanonChange(
  bible: SeriesBible,
  change: Omit<CanonChange, "status">,
): CanonChange {
  if (change.mutations.length === 0) {
    throw new SeriesBibleError(
      `canon change ${change.changeId} proposes no mutations`,
    );
  }
  const staged: CanonChange = { ...change, status: "PROPOSED" };
  bible.canonChanges.push(staged);
  return staged;
}

/** Append one prior-episode summary (spec §10 "prior episode summaries"). */
export function addEpisodeSummary(
  bible: SeriesBible,
  summary: EpisodeSummary,
): EpisodeSummary {
  if (summary.summary.trim().length === 0) {
    throw new SeriesBibleError(
      `episode summary for ${summary.episode} must be non-empty`,
    );
  }
  if (bible.episodeSummaries.some((s) => s.episode === summary.episode)) {
    throw new SeriesBibleError(
      `episode summary already recorded for ${summary.episode}`,
    );
  }
  bible.episodeSummaries.push(summary);
  return summary;
}

/** All prior-episode summaries for episodes before the queried one. */
export function episodeSummariesBefore(
  bible: SeriesBible,
  episode: string,
): EpisodeSummary[] {
  return bible.episodeSummaries.filter((s) => s.episode < episode);
}

/** Append one in-world timeline event (spec §10 "timeline"). */
export function addTimelineEvent(
  bible: SeriesBible,
  event: TimelineEvent,
): TimelineEvent {
  if (event.eventId.trim().length === 0) {
    throw new SeriesBibleError("timeline eventId must be non-empty");
  }
  if (bible.timeline.some((e) => e.eventId === event.eventId)) {
    throw new SeriesBibleError(`timeline event already recorded: ${event.eventId}`);
  }
  bible.timeline.push(event);
  return event;
}