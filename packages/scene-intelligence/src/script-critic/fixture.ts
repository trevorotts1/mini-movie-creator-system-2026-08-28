/**
 * Fixture screenplay for DIR-006 tests — synthetic data, safe to analyze.
 * "The Vault Job" — a two-scene heist mini-short engineered to trigger
 * every heuristic critic rule class without any real-world content.
 */
import type { CriticContext, Screenplay } from "./critic-model.js";

/** Structurally healthy screenplay: the critic should return verdict "pass". */
export const CLEAN_SCREENPLAY: Screenplay = {
  id: "fx-vault-job-clean",
  title: "The Vault Job",
  logline: "A retired safecracker takes one last job to save her sister's bakery.",
  scenes: [
    {
      index: 1,
      heading: "INT. BAKERY - NIGHT",
      action:
        "MARA wipes flour from her hands and studies the vault blueprint taped to the counter. Neon from the sign outside pulses through the window.",
      dialogue: [
        { character: "MARA", text: "One last job. Then the bakery is safe forever." },
        { character: "DEACON", text: "You say that every year." },
        { character: "MARA", text: "This year I mean it." },
      ],
      plannedDurationSeconds: 30,
    },
    {
      index: 2,
      heading: "INT. BAKERY - NIGHT",
      action:
        "DEACON spreads the blueprint wider. MARA circles three pressure plates with a grease pencil while the oven ticks behind them.",
      dialogue: [
        { character: "DEACON", text: "Three plates, forty seconds between rotations." },
        { character: "MARA", text: "Then we move on the second chime, not before." },
      ],
      plannedDurationSeconds: 28,
    },
  ],
};

/** Same screenplay with every defect class present at once. */
export const FLAWED_SCREENPLAY: Screenplay = {
  id: "fx-vault-job-flawed",
  title: "The Vault Job (rough draft)",
  logline: "A retired safecracker takes one last job to save her sister's bakery.",
  scenes: [
    {
      index: 1,
      heading: "INT. BAKERY - NIGHT",
      action:
        "MARA wipes flour from her hands and studies the vault blueprint taped to the counter.",
      dialogue: [
        { character: "MARA", text: "One last job. Then the bakery is safe forever." },
        { character: "DEACON", text: "You say that every year." },
        { character: "MARA", text: "This year I mean it." },
      ],
      plannedDurationSeconds: 30,
    },
    {
      index: 2,
      heading: "INT. SEWER TUNNEL - NIGHT",
      action:
        "The crew wades through the storm drain toward the bank's foundation. No blueprint anywhere in the tunnel dark.",
      dialogue: [
        { character: "DEACON", text: "Faster. We have no blueprint and half the time gone." },
      ],
      plannedDurationSeconds: 6,
    },
    {
      index: 3,
      heading: "INT. BANK BOARDROOM - DAY",
      action:
        "A wall of suits stares at MARA, who suddenly walks to the window. Mara is no longer scarred, though the canon sheet insists otherwise.",
      dialogue: [
        {
          character: "MARA",
          text:
            "Let me explain to every single one of you how a vault works, from the geology of the bedrock this city was founded on, through the metallurgy of every hinge, rivet, tumbler, spring, and gear inside it, to the precise choreography of the guards, their shift rotations, their coffee breaks, the blind spots of each camera along every corridor, and finally to the exact weight, balance, and swagger of the door itself, which I will now describe for eleven unbroken minutes.",
        },
      ],
      plannedDurationSeconds: 200,
    },
  ],
};

/** Character sheets + continuity canon matching the fixtures above. */
export const FIXTURE_CONTEXT: CriticContext = {
  characters: [
    {
      name: "MARA",
      voiceDescription: "short sentences, dry wit, never explains herself",
      physicalDescription: "silver braid, lean build, scarred left eyebrow",
      bannedPhrases: ["trust me", "piece of cake"],
    },
    {
      name: "DEACON",
      voiceDescription: "clipped, numbers-first, calm under pressure",
      physicalDescription: "heavy shoulders, grey stubble",
      bannedPhrases: ["easy money"],
    },
  ],
  continuityNotes: [
    "blueprint: Mara keeps the vault blueprint from scene 1 onward",
  ],
};