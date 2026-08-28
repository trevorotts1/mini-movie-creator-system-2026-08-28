/**
 * Barrel for the Series Bible module (CHAR-012, spec §10).
 */

export {
  approveCanonChange,
  baseCanon,
  canonAtEpisode,
  characterCanonAtEpisode,
  currentCanon,
  episodeNumber,
  rejectCanonChange,
  SeriesBibleError,
} from "./canon.js";
export {
  addEpisodeSummary,
  addTimelineEvent,
  createSeriesBible,
  episodeSummariesBefore,
  proposeCanonChange,
  type CreateSeriesBibleOptions,
} from "./bible.js";
export type {
  CameraLanguage,
  CanonChange,
  CanonChangeStatus,
  CanonMutation,
  CanonState,
  CharacterCanonEvent,
  CharacterId,
  EpisodeCode,
  EpisodeSummary,
  LocationRef,
  PlotThread,
  PlotThreadStatus,
  PropRef,
  Relationship,
  SeriesBible,
  SeriesCharacterLink,
  TimelineEvent,
  VisualStyle,
  VoiceProfileRef,
  WardrobeRef,
  WorldRule,
} from "./types.js";