import { BaseRepository } from "../base.js";
import type { SqlOutputValue } from "../../connection/index.js";
import { ASSET_APPROVAL_STATES, type AssetApprovalState } from "./asset-states.js";
import {
  CHARACTER_STATES,
  type AppearanceVersion,
  type AppearanceVersionInput,
  type Character,
  type CharacterInput,
  type CharacterPatch,
  type CharacterState,
  type IdentityAsset,
  type IdentityAssetInput,
  type IdentityAssetPatch,
  type IdentityVersion,
  type IdentityVersionInput,
} from "./types.js";

/** Error thrown on illegal character-library repository operations. */
export class CharacterRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterRepositoryError";
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function str(value: SqlOutputValue | undefined): string {
  return String(value);
}

function strOrNull(value: SqlOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: SqlOutputValue | undefined): number {
  return Number(value);
}

function bool(value: SqlOutputValue | undefined): boolean {
  return Number(value) === 1;
}

function mapCharacter(row: Record<string, SqlOutputValue>): Character {
  return {
    characterId: str(row["character_id"]),
    displayName: str(row["display_name"]),
    state: str(row["state"]) as CharacterState,
    voiceProfileId: strOrNull(row["voice_profile_id"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapIdentityVersion(row: Record<string, SqlOutputValue>): IdentityVersion {
  return {
    id: num(row["id"]),
    characterId: str(row["character_id"]),
    versionLabel: str(row["version_label"]),
    description: strOrNull(row["description"]),
    createdAt: str(row["created_at"]),
  };
}

function mapIdentityAsset(row: Record<string, SqlOutputValue>): IdentityAsset {
  return {
    assetId: str(row["asset_id"]),
    identityVersionId: num(row["identity_version_id"]),
    characterId: str(row["character_id"]),
    ghlFileId: strOrNull(row["ghl_file_id"]),
    ghlFolderId: strOrNull(row["ghl_folder_id"]),
    ghlUrl: strOrNull(row["ghl_url"]),
    sha256: strOrNull(row["sha256"]),
    localCachePath: strOrNull(row["local_cache_path"]),
    width: num(row["width"]),
    height: num(row["height"]),
    provider: str(row["provider"]),
    model: str(row["model"]),
    sourceJobId: strOrNull(row["source_job_id"]),
    prompt: str(row["prompt"]),
    approvalState: str(row["approval_state"]) as AssetApprovalState,
    canonical: bool(row["canonical"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

/**
 * Episode order key (mirrors @mmcs/character-library CHAR-006):
 * `S01E09` -> 10009. Lexicographic string comparison is WRONG for
 * episodes (S01E08 >= S01E10 and S02E03 >= S10E01 are both true as
 * strings and both false numerically).
 */
function episodeNumber(episode: string): number {
  const match = /^S(\d+)E(\d+)$/.exec(episode);
  if (match === null) {
    throw new CharacterRepositoryError(
      `episode must match S<season>E<episode>, got "${episode}"`,
    );
  }
  return Number(match[1]) * 10000 + Number(match[2]);
}

function mapAppearanceVersion(row: Record<string, SqlOutputValue>): AppearanceVersion {
  return {
    id: num(row["id"]),
    characterId: str(row["character_id"]),
    versionLabel: str(row["version_label"]),
    hairVersion: str(row["hair_version"]),
    wardrobeVersion: str(row["wardrobe_version"]),
    baseIdentityVersionId: num(row["base_identity_version_id"]),
    effectiveEpisode: strOrNull(row["effective_episode"]),
    effectiveTime: strOrNull(row["effective_time"]),
    changeNote: strOrNull(row["change_note"]),
    state: str(row["state"]) as AssetApprovalState,
    createdAt: str(row["created_at"]),
  };
}

/**
 * Global Character Library persistence (spec §9). Characters are keyed by
 * their permanent stable business ID; display names are mutable prose.
 */
export class CharacterRepository extends BaseRepository {
  readonly name = "characters";

  create(input: CharacterInput): Character {
    if (!CHARACTER_STATES.includes(input.state ?? "DRAFT")) {
      throw new CharacterRepositoryError(`invalid character state: ${String(input.state)}`);
    }
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO characters (character_id, display_name, state, voice_profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.characterId,
        input.displayName,
        input.state ?? "DRAFT",
        input.voiceProfileId ?? null,
        now,
        now,
      );
    return this.findById(input.characterId) as Character;
  }

  findById(characterId: string): Character | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM characters WHERE character_id = ?", characterId),
      mapCharacter,
    );
  }

  update(characterId: string, patch: CharacterPatch): Character | undefined {
    const current = this.findById(characterId);
    if (current === undefined) {
      return undefined;
    }
    const next: Character = {
      ...current,
      displayName: patch.displayName ?? current.displayName,
      state: patch.state ?? current.state,
      voiceProfileId:
        patch.voiceProfileId === undefined
          ? current.voiceProfileId
          : patch.voiceProfileId,
    };
    if (!CHARACTER_STATES.includes(next.state)) {
      throw new CharacterRepositoryError(`invalid character state: ${String(next.state)}`);
    }
    this.db
      .prepare(
        "UPDATE characters SET display_name = ?, state = ?, voice_profile_id = ?, updated_at = ? WHERE character_id = ?",
      )
      .run(next.displayName, next.state, next.voiceProfileId, isoNow(), characterId);
    return this.findById(characterId);
  }

  delete(characterId: string): boolean {
    return (
      Number(this.db.prepare("DELETE FROM characters WHERE character_id = ?").run(characterId).changes) > 0
    );
  }

  list(): Character[] {
    return this.db
      .all("SELECT * FROM characters ORDER BY character_id")
      .map(mapCharacter);
  }
}

/**
 * Append-only identity-version history (spec §9 "Identity versioning
 * (immutable history)"). The database triggers refuse UPDATE/DELETE; the
 * repository offers create + reads only.
 */
export class IdentityVersionRepository extends BaseRepository {
  readonly name = "character-identity-versions";

  create(input: IdentityVersionInput): IdentityVersion {
    if (input.versionLabel.length === 0) {
      throw new CharacterRepositoryError("versionLabel must be non-empty");
    }
    this.db
      .prepare(
        "INSERT INTO character_identity_versions (character_id, version_label, description, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(input.characterId, input.versionLabel, input.description ?? null, isoNow());
    return this.db
      .all(
        "SELECT * FROM character_identity_versions WHERE character_id = ? AND version_label = ?",
        input.characterId,
        input.versionLabel,
      )
      .map(mapIdentityVersion)[0] as IdentityVersion;
  }

  findById(id: number): IdentityVersion | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM character_identity_versions WHERE id = ?", id),
      mapIdentityVersion,
    );
  }

  listForCharacter(characterId: string): IdentityVersion[] {
    return this.db
      .all(
        "SELECT * FROM character_identity_versions WHERE character_id = ? ORDER BY id",
        characterId,
      )
      .map(mapIdentityVersion);
  }

  /** Ordered history: index 0 is the original identity version. */
  listHistory(characterId: string): IdentityVersion[] {
    return this.listForCharacter(characterId);
  }
}

/**
 * Canonical identity asset records (spec §9): durable GHL file/folder IDs,
 * URL, SHA-256, generation provenance, approval state, canonical flag.
 */
export class IdentityAssetRepository extends BaseRepository {
  readonly name = "character-identity-assets";

  create(input: IdentityAssetInput): IdentityAsset {
    if (!ASSET_APPROVAL_STATES.includes(input.approvalState ?? "DRAFT")) {
      throw new CharacterRepositoryError(
        `invalid asset approval state: ${String(input.approvalState)}`,
      );
    }
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO character_identity_assets (
           asset_id, identity_version_id, character_id, ghl_file_id, ghl_folder_id,
           ghl_url, sha256, local_cache_path, width, height, provider, model,
           source_job_id, prompt, approval_state, canonical, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.assetId,
        input.identityVersionId,
        input.characterId,
        input.ghlFileId ?? null,
        input.ghlFolderId ?? null,
        input.ghlUrl ?? null,
        input.sha256 ?? null,
        input.localCachePath ?? null,
        input.width,
        input.height,
        input.provider,
        input.model,
        input.sourceJobId ?? null,
        input.prompt,
        input.approvalState ?? "DRAFT",
        input.canonical === true ? 1 : 0,
        now,
        now,
      );
    return this.findByAssetId(input.assetId) as IdentityAsset;
  }

  findByAssetId(assetId: string): IdentityAsset | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM character_identity_assets WHERE asset_id = ?", assetId),
      mapIdentityAsset,
    );
  }

  listForCharacter(characterId: string): IdentityAsset[] {
    return this.db
      .all(
        "SELECT * FROM character_identity_assets WHERE character_id = ? ORDER BY created_at, asset_id",
        characterId,
      )
      .map(mapIdentityAsset);
  }

  /** The one canonical master for a character, when LOCKED. */
  findCanonical(characterId: string): IdentityAsset | undefined {
    return this.mapRow(
      this.db.get(
        "SELECT * FROM character_identity_assets WHERE character_id = ? AND canonical = 1",
        characterId,
      ),
      mapIdentityAsset,
    );
  }

  update(assetId: string, patch: IdentityAssetPatch): IdentityAsset | undefined {
    const current = this.findByAssetId(assetId);
    if (current === undefined) {
      return undefined;
    }
    const next: IdentityAsset = {
      ...current,
      ghlFileId: patch.ghlFileId === undefined ? current.ghlFileId : patch.ghlFileId,
      ghlFolderId: patch.ghlFolderId === undefined ? current.ghlFolderId : patch.ghlFolderId,
      ghlUrl: patch.ghlUrl === undefined ? current.ghlUrl : patch.ghlUrl,
      sha256: patch.sha256 === undefined ? current.sha256 : patch.sha256,
      localCachePath:
        patch.localCachePath === undefined ? current.localCachePath : patch.localCachePath,
      approvalState: patch.approvalState ?? current.approvalState,
      canonical: patch.canonical === undefined ? current.canonical : patch.canonical,
    };
    if (!ASSET_APPROVAL_STATES.includes(next.approvalState)) {
      throw new CharacterRepositoryError(
        `invalid asset approval state: ${String(next.approvalState)}`,
      );
    }
    this.db
      .prepare(
        `UPDATE character_identity_assets SET
           ghl_file_id = ?, ghl_folder_id = ?, ghl_url = ?, sha256 = ?,
           local_cache_path = ?, approval_state = ?, canonical = ?, updated_at = ?
         WHERE asset_id = ?`,
      )
      .run(
        next.ghlFileId,
        next.ghlFolderId,
        next.ghlUrl,
        next.sha256,
        next.localCachePath,
        next.approvalState,
        next.canonical ? 1 : 0,
        isoNow(),
        assetId,
      );
    return this.findByAssetId(assetId);
  }
}

/**
 * Append-only appearance-version history (spec §9): hair/wardrobe changes
 * create a NEW version with an effective episode and/or time; the base
 * identity master is never replaced. Database triggers enforce immutability.
 */
export class AppearanceVersionRepository extends BaseRepository {
  readonly name = "character-appearance-versions";

  create(input: AppearanceVersionInput): AppearanceVersion {
    const hasEffectivePoint =
      (input.effectiveEpisode !== undefined && input.effectiveEpisode !== null) ||
      (input.effectiveTime !== undefined && input.effectiveTime !== null);
    if (!hasEffectivePoint) {
      throw new CharacterRepositoryError(
        "appearance version requires an effective episode and/or effective time",
      );
    }
    if (input.versionLabel.length === 0 || input.hairVersion.length === 0 || input.wardrobeVersion.length === 0) {
      throw new CharacterRepositoryError(
        "versionLabel, hairVersion and wardrobeVersion must be non-empty",
      );
    }
    const state = input.state ?? "DRAFT";
    if (!ASSET_APPROVAL_STATES.includes(state)) {
      throw new CharacterRepositoryError(`invalid appearance state: ${String(input.state)}`);
    }
    this.db
      .prepare(
        `INSERT INTO character_appearance_versions (
           character_id, version_label, hair_version, wardrobe_version,
           base_identity_version_id, effective_episode, effective_time,
           change_note, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.characterId,
        input.versionLabel,
        input.hairVersion,
        input.wardrobeVersion,
        input.baseIdentityVersionId,
        input.effectiveEpisode ?? null,
        input.effectiveTime ?? null,
        input.changeNote ?? null,
        state,
        isoNow(),
      );
    const rows = this.db
      .all(
        "SELECT * FROM character_appearance_versions WHERE character_id = ? AND version_label = ?",
        input.characterId,
        input.versionLabel,
      )
      .map(mapAppearanceVersion);
    return rows[0] as AppearanceVersion;
  }

  findById(id: number): AppearanceVersion | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM character_appearance_versions WHERE id = ?", id),
      mapAppearanceVersion,
    );
  }

  /** Full ordered history; index 0 is the original appearance. */
  listForCharacter(characterId: string): AppearanceVersion[] {
    return this.db
      .all(
        "SELECT * FROM character_appearance_versions WHERE character_id = ? ORDER BY id",
        characterId,
      )
      .map(mapAppearanceVersion);
  }

  /**
   * Resolve the canon-at-the-time appearance version for one episode:
   * the newest version whose effective point is at or before the query
   * (spec §9 — Monica v1 braids for E01–E08, v2 short from E09). Versions
   * with only an effectiveTime never apply to an episode-only query; the
   * query point is matched against the newest version in creation order.
   */
  resolveForEpisode(characterId: string, episode: string): AppearanceVersion | undefined {
    const queryNumber = episodeNumber(episode);
    const history = this.listForCharacter(characterId);
    const first = history[0];
    if (first === undefined) {
      return undefined;
    }
    let resolved = first;
    for (const version of history.slice(1)) {
      if (version.effectiveEpisode === null) {
        continue;
      }
      if (queryNumber < episodeNumber(version.effectiveEpisode)) {
        continue;
      }
      resolved = version;
    }
    return resolved;
  }
}