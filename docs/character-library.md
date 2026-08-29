# Character Library

MMCS keeps recurring characters as **permanent library entries**, not per-episode
prompt memory. The subsystem lives in
`packages/character-library/` (candidates, cast resolution, locking,
identity assets, appearance versions, hair/wardrobe/location/voice bindings,
series-bible, canon approval, asset links, refpack metrics, IDs).

## How a character enters the library (gate 3)

1. `mmcs cast` resolves every screenplay role to a library ID
   (`CHAR_<NAME>_<NNN>` style). An entry that already exists and is CANONICAL
   is reused; only genuinely new characters proceed to candidate generation.
2. A genuinely new character gets **exactly 3 candidates**, presented as
   Character 1 / 2 / 3.
3. The operator picks `1` / `2` / `3` via `mmcs choose-character <n>`, or
   `4 - Try Again`, which creates three NEW candidates. Rejected candidates are
   terminal (REJECTED forever, never reusable, never CANONICAL).
4. `mmcs approve-character <id>` locks the selected candidate to **CANONICAL**.
   Selection alone never locks — approval is a persisted domain state
   (`packages/core/src/approvals/`), enforced in gate order by the
   `ApprovalStore`.

Non-negotiables (also encoded in the skill,
`skills/mini-movie-creator/SKILL.md` hard behaviors 7–10):

- Downstream references use the permanent library ID, never a display name.
- Only the APPROVED candidate may be locked (REJECTED candidates throw).
- Every approved reference asset is archived to GHL Media Storage at lock
  time; the GHL file ID, URL, and checksum are persisted and reused verbatim.

## Where characters are stored

- **Engine state:** SQLite rows + asset records via the packages under
  `packages/` (durable, resumable — never chat context).
- **Pixel references:** the GHL archive folder tree
  `Convert and Flow/Character Library/<Character Name>/` with subfolders for
  Identity Masters, Expressions, Wardrobe, Voice References, and Approved
  Scene References (spec §17). See `docs/ghl-setup.md`.

## Inspecting the library

```bash
mmcs character list        # library entries
mmcs character show <id>   # one entry's identity assets + appearance versions
```

The demo end-to-end run in `examples/demo-series/pipeline.test.ts` walks the
candidate → choose → lock round with zero provider spend — see
`docs/first-series.md`.