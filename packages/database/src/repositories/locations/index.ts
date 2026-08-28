/**
 * Location/prop schema repositories (CORE-005, spec §19): recurring
 * location masters with approved angles/day-night states, props, and the
 * durable GHL linkage for both.
 */
export { LocationRepository, LocationRepositoryError, PropRepository } from "./locations.js";
export {
  LOCATION_ANGLE_KINDS,
  LOCATION_TIMES_OF_DAY,
  type Location,
  type LocationAngleKind,
  type LocationAsset,
  type LocationAssetInput,
  type LocationAssetPatch,
  type LocationInput,
  type LocationPatch,
  type LocationTimeOfDay,
  type Prop,
  type PropAsset,
  type PropAssetInput,
  type PropAssetPatch,
  type PropInput,
  type PropPatch,
} from "./types.js";