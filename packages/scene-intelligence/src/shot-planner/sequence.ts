/**
 * Sequence ordering — DIR-010.
 *
 * Final ordering/numbering pass over planned shots. `planSceneShots` already
 * emits shots in sequence order; this module exists so later replanning
 * (splitting a shot on retry, splicing an insert) can renumber deterministically
 * without hand-editing records. Ids stay stable for unchanged indices
 * (`<prefix>_SH<NN>`); sequence_index is always 1..N contiguous.
 */

import { ShotPlannerValidationError } from "./types.js";
import type { ShotSpecificationRecord } from "./types.js";

/**
 * Renumber shots 1..N in array order. When a record's shot_id already matches
 * its new position, it is kept as-is; otherwise the id is rebuilt from
 * `prefix` (default: derived from scene_id). Throws on duplicate shot ids in
 * the input to prevent silent record collisions.
 */
export function planShotSequence(
  shots: readonly ShotSpecificationRecord[],
  prefix?: string,
): ShotSpecificationRecord[] {
  const seen = new Set<string>();
  for (const s of shots) {
    if (seen.has(s.shot_id)) {
      throw new ShotPlannerValidationError(`duplicate shot_id ${s.shot_id}`);
    }
    seen.add(s.shot_id);
  }

  return shots.map((shot, index) => {
    const sequence = index + 1;
    const base = prefix ?? shot.scene_id;
    const expected = `${base}_SH${String(sequence).padStart(2, "0")}`;
    if (shot.sequence_index === sequence && shot.shot_id === expected) {
      return shot;
    }
    return { ...shot, sequence_index: sequence, shot_id: expected };
  });
}