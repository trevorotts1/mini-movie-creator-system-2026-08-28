import type { Migration } from "../types.js";

/**
 * Band `020_` (CORE-005): characters, identity versions (immutable
 * history), appearance versions with effective episode/time, and the
 * locations/props reference tables. Every canonical asset table carries
 * the spec §9 durable GHL linkage columns (`ghl_file_id`, `ghl_folder_id`,
 * `ghl_url`, `sha256`).
 *
 * Immutability: `character_identity_versions` and
 * `character_appearance_versions` are append-only history (spec §9
 * "Identity versioning (immutable history)"). BEFORE UPDATE/DELETE
 * triggers raise ABORT so no later hair/wardrobe/identity change can
 * mutate or erase a historical version — the history is enforced by the
 * database itself, not only by repository discipline.
 *
 * Character deletion is refused while identity history exists
 * (`ON DELETE RESTRICT`): destroying the master destroys every historical
 * version's meaning, so it never happens silently.
 */

const SHA256_CHECK =
  "(sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'))";

const CHARACTERS_UP = `
CREATE TABLE characters (
  character_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT', 'APPROVED', 'LOCKED', 'CANONICAL', 'RETIRED')),
  voice_profile_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`.trim();

const IDENTITY_VERSIONS_UP = `
CREATE TABLE character_identity_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL
    REFERENCES characters(character_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version_label TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (character_id, version_label)
) STRICT;

CREATE TRIGGER character_identity_versions_no_update
BEFORE UPDATE ON character_identity_versions
BEGIN
  SELECT RAISE(ABORT, 'character_identity_versions is append-only: identity history is immutable (spec §9)');
END;

CREATE TRIGGER character_identity_versions_no_delete
BEFORE DELETE ON character_identity_versions
BEGIN
  SELECT RAISE(ABORT, 'character_identity_versions is append-only: identity history is immutable (spec §9)');
END;
`.trim();

const IDENTITY_ASSETS_UP = `
CREATE TABLE character_identity_assets (
  asset_id TEXT PRIMARY KEY,
  identity_version_id INTEGER NOT NULL
    REFERENCES character_identity_versions(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL
    REFERENCES characters(character_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ghl_file_id TEXT,
  ghl_folder_id TEXT,
  ghl_url TEXT,
  sha256 TEXT CHECK ${SHA256_CHECK},
  local_cache_path TEXT,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  source_job_id TEXT,
  prompt TEXT NOT NULL,
  approval_state TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (approval_state IN ('DRAFT', 'REVIEW', 'APPROVED', 'CANONICAL', 'RETIRED', 'REJECTED')),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK (canonical IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_identity_assets_character
  ON character_identity_assets (character_id, identity_version_id);

-- Spec §9: a character has exactly ONE canonical identity master. The
-- partial unique index enforces it at the database level.
CREATE UNIQUE INDEX idx_identity_assets_one_canonical
  ON character_identity_assets (character_id) WHERE canonical = 1;
`.trim();

const APPEARANCE_VERSIONS_UP = `
CREATE TABLE character_appearance_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL
    REFERENCES characters(character_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version_label TEXT NOT NULL,
  hair_version TEXT NOT NULL,
  wardrobe_version TEXT NOT NULL,
  base_identity_version_id INTEGER NOT NULL
    REFERENCES character_identity_versions(id) ON DELETE RESTRICT,
  effective_episode TEXT,
  effective_time TEXT,
  change_note TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT', 'REVIEW', 'APPROVED', 'CANONICAL', 'RETIRED', 'REJECTED')),
  created_at TEXT NOT NULL,
  UNIQUE (character_id, version_label)
) STRICT;

CREATE INDEX idx_appearance_versions_character
  ON character_appearance_versions (character_id);

CREATE TRIGGER character_appearance_versions_no_update
BEFORE UPDATE ON character_appearance_versions
BEGIN
  SELECT RAISE(ABORT, 'character_appearance_versions is append-only: appearance history is immutable (spec §9)');
END;

CREATE TRIGGER character_appearance_versions_no_delete
BEFORE DELETE ON character_appearance_versions
BEGIN
  SELECT RAISE(ABORT, 'character_appearance_versions is append-only: appearance history is immutable (spec §9)');
END;
`.trim();

const LOCATIONS_UP = `
CREATE TABLE locations (
  location_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE location_assets (
  asset_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL
    REFERENCES locations(location_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  angle_kind TEXT NOT NULL CHECK (angle_kind IN ('wide', 'medium', 'reverse')),
  time_of_day TEXT CHECK (time_of_day IN ('day', 'night')),
  ghl_file_id TEXT,
  ghl_folder_id TEXT,
  ghl_url TEXT,
  sha256 TEXT CHECK ${SHA256_CHECK},
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_location_assets_location
  ON location_assets (location_id);
`.trim();

const PROPS_UP = `
CREATE TABLE props (
  prop_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE prop_assets (
  asset_id TEXT PRIMARY KEY,
  prop_id TEXT NOT NULL
    REFERENCES props(prop_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ghl_file_id TEXT,
  ghl_folder_id TEXT,
  ghl_url TEXT,
  sha256 TEXT CHECK ${SHA256_CHECK},
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_prop_assets_prop
  ON prop_assets (prop_id);
`.trim();

export const createCharacters: Migration = {
  id: "0201",
  name: "create characters",
  up: CHARACTERS_UP,
  down: "DROP TABLE characters;",
};

export const createIdentityVersions: Migration = {
  id: "0202",
  name: "create character identity versions + assets",
  up: IDENTITY_VERSIONS_UP + "\n" + IDENTITY_ASSETS_UP,
  down: `
DROP TABLE character_identity_assets;
DROP TRIGGER character_identity_versions_no_update;
DROP TRIGGER character_identity_versions_no_delete;
DROP TABLE character_identity_versions;
DROP INDEX IF EXISTS idx_identity_assets_one_canonical;
`.trim(),
};

export const createAppearanceVersions: Migration = {
  id: "0203",
  name: "create character appearance versions",
  up: APPEARANCE_VERSIONS_UP,
  down: `
DROP TRIGGER character_appearance_versions_no_update;
DROP TRIGGER character_appearance_versions_no_delete;
DROP TABLE character_appearance_versions;
`.trim(),
};

export const createLocationsAndProps: Migration = {
  id: "0204",
  name: "create locations, props and their assets",
  up: LOCATIONS_UP + "\n" + PROPS_UP,
  down: `
DROP TABLE prop_assets;
DROP TABLE props;
DROP TABLE location_assets;
DROP TABLE locations;
`.trim(),
};

/** Band `020_`: character/location/appearance schema (CORE-005). */
export const characterMigrations: readonly Migration[] = [
  createCharacters,
  createIdentityVersions,
  createAppearanceVersions,
  createLocationsAndProps,
];