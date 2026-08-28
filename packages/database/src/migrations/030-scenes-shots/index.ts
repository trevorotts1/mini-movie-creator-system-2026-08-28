import type { Migration } from "../types.js";

/**
 * Band `030_` (CORE-006): scenes / shots / shot references.
 *
 * Three migrations:
 * - `0301` creates `scenes` — narrative planning units (spec §7: scenes are
 *   planned separately from generation shots; a 45-second scene is typically
 *   5–8 shots).
 * - `0302` creates `shots` — one row per generation shot whose columns carry
 *   exactly the spec §12 Shot Specification Record fields (30 required
 *   fields, provider-independent: creative intent is never bound to one
 *   provider's request format).
 * - `0303` creates `shot_references` — the reference assets planned/attached
 *   to a shot (spec §7/§8: reference budget planning, keyframe strategy,
 *   scene masters).
 *
 * References to series/episodes/characters/locations are plain TEXT soft
 * references on purpose: those tables live in sibling bands (`010_`, `020_`)
 * that may apply independently of this one, and hard foreign keys across
 * bands would make band 030 un-appliable on its own. Enforcing the
 * references is the repositories'/callers' job; the columns keep the ids
 * stable for a later PostgreSQL migration (spec §25).
 */
export const scenesMigrations: readonly Migration[] = [
  {
    id: "0301",
    name: "create scenes",
    up: `
CREATE TABLE scenes (
  scene_id TEXT PRIMARY KEY,
  episode_id TEXT,
  sequence_index INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  duration_seconds REAL,
  character_ids TEXT,
  location_id TEXT,
  scene_master_asset_id TEXT,
  visual_source_type TEXT CHECK (
    visual_source_type IN (
      'GENERATED_VIDEO',
      'AI_STILL',
      'ANIMATED_STILL',
      'STOCK_OR_UPSCALED',
      'NATIVE_GRAPHICS',
      'PENDING'
    )
  ),
  planning_status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (
    planning_status IN ('PLANNED', 'STORYBOARD', 'APPROVED', 'GENERATING', 'COMPLETE', 'BLOCKED')
  ),
  estimated_cost_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_scenes_episode ON scenes (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX idx_scenes_location ON scenes (location_id) WHERE location_id IS NOT NULL;
`.trim(),
    down: `
DROP INDEX IF EXISTS idx_scenes_location;
DROP INDEX IF EXISTS idx_scenes_episode;
DROP TABLE scenes;
`.trim(),
  },
  {
    id: "0302",
    name: "create shots",
    up: `
CREATE TABLE shots (
  shot_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL,
  sequence_index INTEGER NOT NULL,
  target_duration REAL NOT NULL,
  characters TEXT NOT NULL DEFAULT '[]',
  character_versions TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  wardrobe TEXT NOT NULL DEFAULT '[]',
  props TEXT NOT NULL DEFAULT '[]',
  dialogue TEXT,
  action TEXT,
  emotion TEXT,
  camera_angle TEXT,
  camera_motion TEXT,
  lens_style TEXT,
  lighting TEXT,
  start_state TEXT,
  end_state TEXT,
  continuity_requirements TEXT,
  reference_assets TEXT NOT NULL DEFAULT '[]',
  keyframe_strategy TEXT NOT NULL DEFAULT 'NONE' CHECK (
    keyframe_strategy IN (
      'NONE',
      'START_ONLY',
      'START_AND_END',
      'SCENE_MASTER',
      'MULTIMODAL_REFERENCE'
    )
  ),
  preferred_provider TEXT,
  fallback_provider TEXT,
  prompt_source TEXT,
  prompt_compiled TEXT,
  prompt_character_count INTEGER,
  estimated_cost REAL,
  approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    approval_status IN ('PENDING', 'STORYBOARD_APPROVED', 'APPROVED', 'REJECTED')
  ),
  generation_status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (
    generation_status IN (
      'NOT_STARTED',
      'PLANNED',
      'SUBMITTED',
      'GENERATING',
      'GENERATED',
      'ARCHIVED',
      'FAILED'
    )
  ),
  qc_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    qc_status IN ('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'FIXING')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_shots_scene ON shots (scene_id);
CREATE INDEX idx_shots_scene_sequence ON shots (scene_id, sequence_index);
CREATE INDEX idx_shots_provider ON shots (preferred_provider) WHERE preferred_provider IS NOT NULL;
`.trim(),
    down: `
DROP INDEX IF EXISTS idx_shots_provider;
DROP INDEX IF EXISTS idx_shots_scene_sequence;
DROP INDEX IF EXISTS idx_shots_scene;
DROP TABLE shots;
`.trim(),
  },
  {
    id: "0303",
    name: "create shot_references",
    up: `
CREATE TABLE shot_references (
  reference_id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL,
  asset_id TEXT,
  reference_kind TEXT NOT NULL CHECK (
    reference_kind IN (
      'IDENTITY',
      'WARDROBE',
      'LOCATION',
      'PROP',
      'SCENE_MASTER',
      'START_KEYFRAME',
      'END_KEYFRAME',
      'POSE_COMPOSITION'
      -- multimodal reference packages (spec §8) may carry any mix; kind
      -- stays one of the above with a score per axis below.
    )
  ),
  identity_value REAL,
  wardrobe_value REAL,
  location_value REAL,
  prop_value REAL,
  pose_value REAL,
  start_state_value REAL,
  end_state_value REAL,
  selected INTEGER NOT NULL DEFAULT 0,
  selected_rank INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_shot_references_shot ON shot_references (shot_id);
CREATE INDEX idx_shot_references_asset ON shot_references (asset_id) WHERE asset_id IS NOT NULL;
`.trim(),
    down: `
DROP INDEX IF EXISTS idx_shot_references_asset;
DROP INDEX IF EXISTS idx_shot_references_shot;
DROP TABLE shot_references;
`.trim(),
  },
];