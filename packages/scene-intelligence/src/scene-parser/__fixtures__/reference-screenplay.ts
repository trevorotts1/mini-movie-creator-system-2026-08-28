/**
 * DIR-009 acceptance fixture (todo.md TASK-DIR-009): a 45-second reference
 * screenplay whose parsed output contains >= 5 named scenes. Six short
 * scenes; combined estimated runtime lands near 45s (dialogue at ~150 wpm,
 * action read as on-screen beats). Text here is inert fixture data.
 */

export const REFERENCE_SCREENPLAY_45S = `TITLE: THE LAST KEY
AUTHOR: MMCS FIXTURE
DRAFT: 2026-08-28

FADE IN:

INT. APARTMENT - KITCHEN - NIGHT

MONA stands at the counter. A brass KEY sits beside a half-drunk cup of
coffee. The window shows rain.

MONA
(not looking up)
You said you'd be here at nine.

DEAN
It's nine-oh-two.

MONA
Two minutes is a habit.

INT. APARTMENT - HALLWAY - CONTINUOUS

DEAN hangs his coat. The hallway light flickers twice.

DEAN (V.O.)
Two minutes. Every time.

EXT. STREET - NIGHT

Rain hammers the pavement. DEAN steps out, collar up, and checks the
empty street.

INT. APARTMENT - LIVING ROOM - NIGHT

MONA turns the brass KEY over once, then sets it in a small wooden BOX.

MONA
Don't come back for this.

DEAN
Mona...

EXT. ALLEY - CONTINUOUS

A single streetlamp. DEAN stops walking. Behind him, an apartment
window goes dark.

DEAN
Goodbye, Mona.

INT. APARTMENT - BEDROOM - LATER

MONA lies down, awake. The KEY is gone from the box. She smiles
without warmth.

FADE OUT.`;

/** Fixture expectation: exactly six named scenes. */
export const REFERENCE_SCENE_COUNT = 6;