/**
 * Domain types for the recurring location/prop repositories (CORE-005,
 * spec §19). Re-exported from the characters types module (single schema
 * domain) so each owned directory exposes its own entry points.
 */
export type {
  Location,
  LocationAngleKind,
  LocationAsset,
  LocationAssetInput,
  LocationAssetPatch,
  LocationInput,
  LocationPatch,
  LocationTimeOfDay,
  Prop,
  PropAsset,
  PropAssetInput,
  PropAssetPatch,
  PropInput,
  PropPatch,
} from "../characters/types.js";
export {
  LOCATION_ANGLE_KINDS,
  LOCATION_TIMES_OF_DAY,
} from "../characters/types.js";