/**
 * Graphics plan validation — pre-render checks so bad graphics data fails
 * loudly before render time, never silently (spec §20/§29 discipline).
 * Pure functions, no React/Remotion.
 */

import { composeGraphics } from "./compose.js";
import { KIND_DEFAULTS } from "./tokens.js";
import type { GraphicsItemSpec, GraphicsKind, ShotPlanRef } from "./types.js";

/** Severity levels: error blocks the plan; warning is reported only. */
export type GraphicsSeverity = "error" | "warning";

/** One validation finding. */
export interface GraphicsIssue {
  severity: GraphicsSeverity;
  code:
    | "empty-id"
    | "duplicate-id"
    | "unknown-kind"
    | "bad-frame-range"
    | "unknown-shot"
    | "empty-text"
    | "overlap"
    | "bad-progress";
  message: string;
  itemId?: string;
}

/** Validate a graphics plan (items + optional shot plan). */
export function validateGraphicsPlan(
  items: readonly GraphicsItemSpec[],
  shots?: readonly ShotPlanRef[],
): GraphicsIssue[] {
  const issues: GraphicsIssue[] = [];
  const shotIds = new Set((shots ?? []).map((s) => s.shotId));
  const seen = new Set<string>();

  for (const spec of items) {
    // ids must be present + unique — deterministic QC reports need them.
    if (!spec.id || typeof spec.id !== "string") {
      issues.push({ severity: "error", code: "empty-id", message: "graphics item missing id", itemId: spec.id });
      continue;
    }
    if (seen.has(spec.id)) {
      issues.push({ severity: "error", code: "duplicate-id", message: `duplicate item id "${spec.id}"`, itemId: spec.id });
    }
    seen.add(spec.id);

    if (!spec.kind || !(spec.kind in KIND_DEFAULTS)) {
      issues.push({
        severity: "error",
        code: "unknown-kind",
        message: `item "${spec.id}" has unknown kind ${JSON.stringify(spec.kind)}`,
        itemId: spec.id,
      });
    }

    // Frame range sanity: frameTo must be after frameFrom when absolute.
    const from = spec.shotId ? undefined : spec.frameFrom;
    const to = spec.shotId ? undefined : spec.frameTo;
    if (from !== undefined && to !== undefined && to <= from) {
      issues.push({
        severity: "error",
        code: "bad-frame-range",
        message: `item "${spec.id}" frameTo (${to}) <= frameFrom (${from})`,
        itemId: spec.id,
      });
    }

    // Binding sanity: shotId must exist in the plan.
    if (spec.shotId && !shotIds.has(spec.shotId)) {
      issues.push({
        severity: "error",
        code: "unknown-shot",
        message: `item "${spec.id}" binds unknown shotId "${spec.shotId}"`,
        itemId: spec.id,
      });
    }

    // Text sanity: text-bearing kinds need text; credits carry rows.
    const needsText: GraphicsKind[] = ["title", "kicker", "subtitle", "lowerThird", "logo"];
    if (needsText.includes(spec.kind)) {
      const hasText = Array.isArray(spec.text)
        ? spec.text.length > 0
        : typeof spec.text === "string" && spec.text.length > 0;
      if (!hasText && !spec.subtext) {
        issues.push({
          severity: "warning",
          code: "empty-text",
          message: `item "${spec.id}" (${spec.kind}) has no text`,
          itemId: spec.id,
        });
      }
    }
  }

  // Timeline overlap warnings from the composer.
  const stack = composeGraphics({ items, shots });
  for (const w of stack.warnings) {
    if (w.startsWith("overlap:")) {
      issues.push({ severity: "warning", code: "overlap", message: w });
    }
  }

  return issues;
}

/** True when the plan has zero error-severity issues. */
export function graphicsPlanIsValid(
  items: readonly GraphicsItemSpec[],
  shots?: readonly ShotPlanRef[],
): boolean {
  return validateGraphicsPlan(items, shots).every((i) => i.severity !== "error");
}