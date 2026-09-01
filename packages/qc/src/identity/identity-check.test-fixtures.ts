/**
 * Identity-check test fixtures — QC-002.
 *
 * Shared canonical identity asset (spec §9 record, as produced by CHAR-002),
 * canonical reference image, extracted-frame fixtures, and the registry
 * selection used in tests and offline dry runs. Kept out of the test file so
 * the doctored-fixture acceptance story is inspectable as data.
 */

import type { IdentityAsset } from "@mmcs/character-library/identity-asset/types";
import type {
  ExtractedFrame,
  VisionImage,
  VisionModelSelection,
} from "./identity.js";

/** Spec §9 example shape: Monica Bennett, identity v1, canonical + archived. */
export function monicaCanonicalAsset(): IdentityAsset {
  return {
    assetId: "IDENT_ASSET_MONICA_V1_001",
    characterId: "CHAR_MONICA_BENNETT_001",
    identityVersion: "v1",
    ghlFileId: "ghl-file-monica-v1",
    ghlFolderId: "ghl-folder-monica-identity",
    ghlUrl: "https://services.leadconnectorhq.com/assets/monica-face-front-v1.png",
    sha256: "aa".repeat(32),
    localCachePath: "/media/library/characters/monica/face-front-master-v1.png",
    width: 1024,
    height: 1024,
    provider: "agnes",
    model: "agnes-image-2.1-flash",
    sourceJobId: "AGNES_JOB_MONICA_V1",
    prompt: "Monica Bennett face front master, identity v1",
    approvalState: "CANONICAL",
    canonical: true,
  };
}

/** The durable canonical reference image the vision model receives as IMAGE 1. */
export function monicaReferenceImage(): VisionImage {
  const asset = monicaCanonicalAsset();
  if (!asset.ghlUrl) {
    throw new Error("fixture asset must carry a durable ghlUrl");
  }
  return {
    source: asset.ghlUrl,
    mimeType: "image/png",
    data: asset.ghlUrl,
  };
}

/** Registry-selected vision model for the imageQc slot (spec §14). */
export function imageQcSelection(): VisionModelSelection {
  return {
    slot: "imageQc",
    modelId: "deepseek/deepseek-v4-flash-vision-exp",
    confidence: "PROVISIONAL",
  };
}

/** Clean frame extracted from a generated shot — same character. */
export function cleanFrame(): ExtractedFrame {
  return {
    image: {
      source: "file:///tmp/mmcs-qc/S01E03_SC04_SH07_monica_closeup_f0042.png",
      mimeType: "image/png",
      data: "file:///tmp/mmcs-qc/S01E03_SC04_SH07_monica_closeup_f0042.png",
    },
    shotId: "SHOT_S01E03_SC04_SH07",
    timestampSeconds: 1.75,
    dimensions: { width: 1920, height: 1080 },
  };
}

/**
 * Doctored frame fixture — the acceptance-critical case. Same shot metadata,
 * but the image bytes were swapped for a different character; the vision model
 * reports a mismatch with the differing attributes named.
 */
export function doctoredFrame(): ExtractedFrame {
  return {
    image: {
      source: "file:///tmp/mmcs-qc/S01E03_SC04_SH07_monica_closeup_DOCTORED.png",
      mimeType: "image/png",
      data: "file:///tmp/mmcs-qc/S01E03_SC04_SH07_monica_closeup_DOCTORED.png",
    },
    shotId: "SHOT_S01E03_SC04_SH07",
    timestampSeconds: 1.75,
    dimensions: { width: 1920, height: 1080 },
  };
}