/**
 * Shot lifecycle vocabularies (spec §12 Shot Specification Record).
 *
 * The three status axes — approval, generation, QC — are provider- and
 * workflow-independent. `keyframeStrategy` mirrors the mutually exclusive
 * §8 classification (none / start only / start+end / scene master /
 * multimodal reference package).
 */

export const KEYFRAME_STRATEGIES = [
  "NONE",
  "START_ONLY",
  "START_AND_END",
  "SCENE_MASTER",
  "MULTIMODAL_REFERENCE",
] as const;

export type KeyframeStrategy = (typeof KEYFRAME_STRATEGIES)[number];

export const APPROVAL_STATUSES = [
  "PENDING",
  "STORYBOARD_APPROVED",
  "APPROVED",
  "REJECTED",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const GENERATION_STATUSES = [
  "NOT_STARTED",
  "PLANNED",
  "SUBMITTED",
  "GENERATING",
  "GENERATED",
  "ARCHIVED",
  "FAILED",
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const QC_STATUSES = ["PENDING", "IN_PROGRESS", "PASSED", "FAILED", "FIXING"] as const;

export type QcStatus = (typeof QC_STATUSES)[number];