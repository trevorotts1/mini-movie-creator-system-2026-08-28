/**
 * Critic-model interface — DIR-006 (runbook §24, spec.md §14).
 *
 * spec.md §14 requires a SEPARATE user-selectable model per QC role; the
 * script critic is one of those roles. This module defines the critic-model
 * contract DIR-007 (revision loop) and DIR-008 (gate 2) program against:
 *
 *   interface CriticModel {
 *     readonly id: string;
 *     readonly reviseOnSeverity: CriticSeverity;
 *     critique(screenplay, context?): Promise<ScriptCritique>;
 *   }
 *
 * Two implementations ship here:
 * - `HeuristicCriticModel` — deterministic, offline rule engine over the
 *   screenplay's structure. Default critic; makes tests and the revision
 *   loop runnable without any provider call.
 * - `RemoteCriticModel` — delegates to an async completion callback (an
 *   OpenRouter/adapter call owned elsewhere), then validates the returned
 *   JSON through the versioned `parseCritique`. Never trusts model output
 *   shape.
 *
 * Screenplay/text content is UNTRUSTED: analyzed and echoed, never executed.
 */

import {
  assembleCritique,
  parseCritique,
  CriticSchemaError,
  type CriticCategory,
  type CriticSeverity,
  type FindingLocation,
  type ScriptCritique,
  type ScriptFinding,
} from "./schema.js";

/** A single line of dialogue in a scene. */
export interface ScreenplayDialogueLine {
  character: string;
  text: string;
}

/** One scene of the screenplay (structural view; prose fields are data). */
export interface ScreenplayScene {
  /** 1-based scene number. */
  index: number;
  /** Slug line, e.g. "INT. WAREHOUSE - NIGHT". */
  heading: string;
  /** Scene prose/action description (untrusted text). */
  action: string;
  dialogue: readonly ScreenplayDialogueLine[];
  /** Approximate on-screen seconds this scene is planned for. */
  plannedDurationSeconds: number;
}

/** Structural screenplay input to the critic. */
export interface Screenplay {
  /** Stable id; echoed into the critique. */
  id: string;
  title: string;
  logline: string;
  scenes: readonly ScreenplayScene[];
}

/**
 * Character sheet entries the critic checks consistency against. All optional
 * fields degrade gracefully on partial sheets.
 */
export interface CriticCharacterSheet {
  name: string;
  /** Canonical speech style; dialogue that contradicts it is flagged. */
  voiceDescription?: string;
  /** Canonical physical traits; scene-action contradictions are flagged. */
  physicalDescription?: string;
  /** Words/phrases the character would never use. */
  bannedPhrases?: readonly string[];
}

/** Context beyond the screenplay itself. */
export interface CriticContext {
  characters?: readonly CriticCharacterSheet[];
  /** Prior-canon constraints (props, locations...); contradictions are findings. */
  continuityNotes?: readonly string[];
}

/** The critic-model contract (runbook §24 DIR-006). */
export interface CriticModel {
  /** Stable critic id (e.g. "heuristic-critic-v1" or an OpenRouter model id). */
  readonly id: string;
  /** Severity at or above which the verdict becomes "revise". */
  readonly reviseOnSeverity: CriticSeverity;
  /** Review one screenplay; returns the versioned critique. */
  critique(screenplay: Screenplay, context?: CriticContext): Promise<ScriptCritique>;
}

/** Tunable thresholds for the heuristic critic. */
export interface HeuristicCriticOptions {
  reviseOnSeverity?: CriticSeverity;
  /** Flag a scene whose planned duration deviates more than this fraction
   *  from the ensemble mean (0 < ratio < 1). Default 0.75. */
  pacingDeviationRatio?: number;
  /** Flag the script when mean seconds-per-dialogue-line is below this.
   *  Default 3. */
  minSecondsPerLine?: number;
  /** Dialogue: flag lines longer than this many words (and 2x the median).
   *  Default 60. */
  maxLineWords?: number;
  /** Now-source for critique timestamps. Default Date.toISOString. */
  now?: () => string;
}

const DEFAULTS: Required<Omit<HeuristicCriticOptions, "now">> = {
  reviseOnSeverity: "major",
  pacingDeviationRatio: 0.75,
  minSecondsPerLine: 3,
  maxLineWords: 60,
};

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function sameName(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

const NEGATIONS = ["no ", "not ", "never ", "without ", "no longer ", "missing ", "absent "] as const;

/**
 * Deterministic offline critic. Rules (one per finding class):
 * - PAC-empty     pacing: no scenes at all.
 * - PAC-static    pacing: a scene's planned duration far off the ensemble mean.
 * - PAC-rushed    pacing: too little planned time per dialogue line overall.
 * - CON-ghost     continuity: a recurring location never returns.
 * - CON-canon     continuity: scene action negates a continuity-note keyword.
 * - DIA-monolog   dialogue: a line far beyond word limits and the median.
 * - DIA-banned    dialogue: a character uses a sheet-banned phrase.
 * - CHA-drift     character-consistency: dialogue negates the voice sheet.
 * - CHA-physical  character-consistency: action negates the physical sheet.
 */
export class HeuristicCriticModel implements CriticModel {
  readonly id: string;
  readonly reviseOnSeverity: CriticSeverity;
  private readonly pacingDeviationRatio: number;
  private readonly minSecondsPerLine: number;
  private readonly maxLineWords: number;
  private readonly now: () => string;

  constructor(id = "heuristic-critic-v1", options: HeuristicCriticOptions = {}) {
    this.id = id;
    this.reviseOnSeverity = options.reviseOnSeverity ?? DEFAULTS.reviseOnSeverity;
    this.pacingDeviationRatio = options.pacingDeviationRatio ?? DEFAULTS.pacingDeviationRatio;
    this.minSecondsPerLine = options.minSecondsPerLine ?? DEFAULTS.minSecondsPerLine;
    this.maxLineWords = options.maxLineWords ?? DEFAULTS.maxLineWords;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async critique(screenplay: Screenplay, context: CriticContext = {}): Promise<ScriptCritique> {
    const findings: ScriptFinding[] = [];
    this.pacingFindings(screenplay, findings);
    this.continuityFindings(screenplay, context, findings);
    this.dialogueFindings(screenplay, context, findings);
    this.characterFindings(screenplay, context, findings);

    return assembleCritique({
      screenplayId: screenplay.id,
      criticModelId: this.id,
      createdAt: this.now(),
      findings,
      reviseOnSeverity: this.reviseOnSeverity,
    });
  }

  private nextId(category: CriticCategory, findings: readonly ScriptFinding[]): string {
    const prefix = CRITIC_CATEGORY_CODES[category];
    const n = findings.filter((f) => f.id.startsWith(`${prefix}-`)).length + 1;
    return `${prefix}-${String(n).padStart(3, "0")}`;
  }

  private push(findings: ScriptFinding[], finding: Omit<ScriptFinding, "id">): void {
    findings.push({ ...finding, id: this.nextId(finding.category, findings) });
  }

  private loc(
    sceneIndex: number | null,
    line: number | null = null,
    character: string | null = null,
  ): FindingLocation {
    return { sceneIndex, line, character };
  }

  private pacingFindings(screenplay: Screenplay, findings: ScriptFinding[]): void {
    const scenes = screenplay.scenes;
    if (scenes.length === 0) {
      this.push(findings, {
        rule: "PAC-empty",
        category: "pacing",
        severity: "critical",
        title: "Screenplay has no scenes",
        detail: "A screenplay without scenes cannot be produced or reviewed.",
        suggestion: "Generate at least one scene.",
        location: this.loc(null),
      });
      return;
    }

    const durations = scenes.map((s) => s.plannedDurationSeconds);
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    for (const scene of scenes) {
      const deviation = mean === 0 ? 1 : Math.abs(scene.plannedDurationSeconds - mean) / mean;
      if (deviation > this.pacingDeviationRatio) {
        const direction =
          scene.plannedDurationSeconds > mean ? "far longer than" : "far shorter than";
        this.push(findings, {
          rule: "PAC-static",
          category: "pacing",
          severity: deviation > this.pacingDeviationRatio * 1.5 ? "major" : "minor",
          title: `Scene ${scene.index} duration is ${direction} the ensemble mean`,
          detail: `Scene ${scene.index} plans ${scene.plannedDurationSeconds}s against a ${mean.toFixed(1)}s ensemble mean (${Math.round(deviation * 100)}% deviation, threshold ${Math.round(this.pacingDeviationRatio * 100)}%).`,
          suggestion:
            scene.plannedDurationSeconds > mean
              ? "Split the scene or trim its action to restore rhythm."
              : "Extend the scene's beats or merge it into a neighbouring scene.",
          location: this.loc(scene.index),
        });
      }
    }

    const totalLines = scenes.reduce((a, s) => a + s.dialogue.length, 0);
    if (totalLines > 0) {
      // True seconds-per-line across the whole script: total planned
      // runtime / total dialogue lines (the old mean / totalLines math
      // undercounted multi-scene scripts and false-flagged healthy pacing).
      const totalDuration = durations.reduce((a, b) => a + b, 0);
      const secondsPerLine = totalDuration / totalLines;
      if (secondsPerLine < this.minSecondsPerLine) {
        this.push(findings, {
          rule: "PAC-rushed",
          category: "pacing",
          severity: "major",
          title: "Dialogue is rushed relative to planned runtime",
          detail: `${totalLines} dialogue lines across ${scenes.length} scene(s) average ${secondsPerLine.toFixed(1)}s each against a ${totalDuration.toFixed(1)}s total planned runtime; minimum is ${this.minSecondsPerLine}s.`,
          suggestion: "Add breathing room between lines or trim dialogue.",
          location: this.loc(null),
        });
      }
    }
  }

  private continuityFindings(
    screenplay: Screenplay,
    context: CriticContext,
    findings: ScriptFinding[],
  ): void {
    // CON-ghost: a recurring location (2+ scenes) whose last appearance sits
    // before the final scene has been abandoned mid-screenplay. Location =
    // the heading part before the conventional " - " time split
    // ("INT. WAREHOUSE - NIGHT" → "int. warehouse"). All comparisons run on
    // scene POSITION (1-based ordinal), never scene.index, so 0-based or
    // sparse scene indices cannot skew the count or the last-scene check.
    const scenePositions = screenplay.scenes.map((_, i) => i + 1);
    const sceneCount = scenePositions.length;
    const sceneLocations = screenplay.scenes.map((s) =>
      (s.heading.split(/\s+-\s+/)[0] ?? s.heading).trim().toLowerCase(),
    );
    const totals = new Map<string, number>();
    const lastSeen = new Map<string, number>();
    screenplay.scenes.forEach((scene, i) => {
      const loc = sceneLocations[i] as string;
      totals.set(loc, (totals.get(loc) ?? 0) + 1);
      lastSeen.set(loc, scenePositions[i] as number);
    });
    for (const [loc, total] of totals) {
      if (total < 2) continue;
      const last = lastSeen.get(loc) ?? 0;
      if (last >= sceneCount) continue;
      const firstScene =
        scenePositions[screenplay.scenes.findIndex((_, i) => sceneLocations[i] === loc)] ?? null;
      this.push(findings, {
        rule: "CON-ghost",
        category: "continuity",
        severity: "minor",
        title: `Recurring location "${loc}" is not revisited`,
        detail: `Location "${loc}" appears in ${total} scene(s) but never returns after scene ${last}, despite the screenplay continuing to scene ${sceneCount}.`,
        suggestion: "Either revisit the location or resolve its thread explicitly.",
        location: this.loc(firstScene),
      });
    }

    // CON-canon: scene action negating an explicit continuity-note keyword.
    for (const note of context.continuityNotes ?? []) {
      const keyword = (note.split(/[:.]/)[0] ?? "").trim().toLowerCase();
      if (keyword.length < 3) continue;
      for (const scene of screenplay.scenes) {
        const actionLower = scene.action.toLowerCase();
        for (const neg of NEGATIONS) {
          if (actionLower.includes(neg + keyword)) {
            this.push(findings, {
              rule: "CON-canon",
              category: "continuity",
              severity: "major",
              title: `Scene ${scene.index} contradicts continuity note "${note.slice(0, 60)}"`,
              detail: `Scene action contains "${neg}${keyword}" while the continuity note establishes "${keyword}".`,
              suggestion: "Align the scene action with the established continuity.",
              location: this.loc(scene.index),
            });
            break;
          }
        }
      }
    }
  }

  private dialogueFindings(
    screenplay: Screenplay,
    context: CriticContext,
    findings: ScriptFinding[],
  ): void {
    const lineWordCounts = screenplay.scenes.flatMap((s) =>
      s.dialogue.map((d) => words(d.text).length),
    );
    const sorted = [...lineWordCounts].sort((a, b) => a - b);
    const median =
      sorted.length === 0
        ? 0
        : sorted.length % 2 === 1
          ? (sorted[(sorted.length - 1) / 2] ?? 0)
          : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;

    for (const scene of screenplay.scenes) {
      scene.dialogue.forEach((d, lineIdx) => {
        const count = words(d.text).length;
        if (count > this.maxLineWords && count > median * 2) {
          this.push(findings, {
            rule: "DIA-monolog",
            category: "dialogue",
            severity: "minor",
            title: `Line ${lineIdx + 1} in scene ${scene.index} is an outlier monologue`,
            detail: `${count} words against a ${this.maxLineWords}-word limit and ${median}-word median; long unbroken speeches stall scenes.`,
            suggestion: "Break the speech with action or a reaction line.",
            location: this.loc(scene.index, lineIdx + 1, d.character),
          });
        }
        const sheet = (context.characters ?? []).find((c) => sameName(c.name, d.character));
        for (const banned of sheet?.bannedPhrases ?? []) {
          // Empty/whitespace phrases match every line — skip them instead of
          // flooding the critique with false DIA-banned findings.
          if (banned.trim() === "") continue;
          if (d.text.toLowerCase().includes(banned.toLowerCase())) {
            this.push(findings, {
              rule: "DIA-banned",
              category: "dialogue",
              severity: "major",
              title: `${d.character} uses banned phrase "${banned}" in scene ${scene.index}`,
              detail: `Line ${lineIdx + 1} contains "${banned}", which the character sheet forbids.`,
              suggestion: `Rewrite the line without "${banned}".`,
              location: this.loc(scene.index, lineIdx + 1, d.character),
            });
          }
        }
      });
    }
  }

  private characterFindings(
    screenplay: Screenplay,
    context: CriticContext,
    findings: ScriptFinding[],
  ): void {
    const sheets = context.characters ?? [];
    for (const scene of screenplay.scenes) {
      const actionLower = scene.action.toLowerCase();

      // CHA-drift: dialogue negating the declared voice style.
      scene.dialogue.forEach((d, lineIdx) => {
        const sheet = sheets.find((c) => sameName(c.name, d.character));
        if (!sheet?.voiceDescription) return;
        const traits = sheet.voiceDescription
          .toLowerCase()
          .split(/[,;.]/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 4);
        for (const trait of traits) {
          const head = trait.split(" ")[0] ?? "";
          if (head.length < 4) continue;
          for (const neg of NEGATIONS) {
            if (d.text.toLowerCase().includes(neg + head)) {
              this.push(findings, {
                rule: "CHA-drift",
                category: "character-consistency",
                severity: "minor",
                title: `${d.character} dialogue drifts from the voice sheet in scene ${scene.index}`,
                detail: `Voice sheet says "${sheet.voiceDescription.slice(0, 60)}"; line ${lineIdx + 1} contains "${neg}${head}".`,
                suggestion: "Rewrite the line to match the character's declared voice.",
                location: this.loc(scene.index, lineIdx + 1, d.character),
              });
              break;
            }
          }
        }
      });

      // CHA-physical: scene action negating a physical sheet trait.
      for (const sheet of sheets) {
        if (!sheet.physicalDescription) continue;
        const traits = sheet.physicalDescription
          .toLowerCase()
          .split(/[,;.]/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 4);
        for (const trait of traits) {
          const head = trait.split(" ")[0] ?? "";
          if (head.length < 4) continue;
          for (const neg of NEGATIONS) {
            if (actionLower.includes(neg + head)) {
              this.push(findings, {
                rule: "CHA-physical",
                category: "character-consistency",
                severity: "major",
                title: `Scene ${scene.index} action contradicts ${sheet.name}'s physical sheet`,
                detail: `Physical sheet says "${sheet.physicalDescription.slice(0, 60)}"; action contains "${neg}${head}".`,
                suggestion: "Align the action description with the canonical appearance.",
                location: this.loc(scene.index, null, sheet.name),
              });
              break;
            }
          }
        }
      }
    }
  }
}

/** Wire shape the remote critic must answer with (schemaVersion 1). */
export const CRITIC_PROMPT_SCHEMA_HINT =
  '{"schemaVersion":1,"screenplayId":"...","criticModelId":"...","createdAt":"ISO-8601","verdict":"pass|revise","findings":[{"id":"...","rule":"...","category":"pacing|continuity|dialogue|character-consistency","severity":"info|minor|major|critical","title":"...","detail":"...","suggestion":null,"location":{"sceneIndex":null,"line":null,"character":null}}],"counts":{"pacing":0,"continuity":0,"dialogue":0,"character-consistency":0}}';

/**
 * Remote critic: delegates to an injected completion callback (the actual
 * OpenRouter/adapter call lives elsewhere — spec.md §14) and validates the
 * JSON through the versioned parser. Model output is untrusted — anything
 * shape-invalid throws CriticSchemaError rather than flowing downstream.
 */
export interface RemoteCriticOptions {
  /** The critic's model id as configured (spec.md §14 separate critic model). */
  id: string;
  reviseOnSeverity?: CriticSeverity;
  /** Performs the completion call; must return the model's raw JSON text. */
  complete: (prompt: string) => Promise<string>;
}

export class RemoteCriticModel implements CriticModel {
  readonly id: string;
  readonly reviseOnSeverity: CriticSeverity;
  private readonly complete: (prompt: string) => Promise<string>;

  constructor(options: RemoteCriticOptions) {
    this.id = options.id;
    this.reviseOnSeverity = options.reviseOnSeverity ?? "major";
    this.complete = options.complete;
  }

  /** Build the critic prompt for a screenplay (text only; never executed). */
  buildPrompt(screenplay: Screenplay, context: CriticContext = {}): string {
    const lines: string[] = [
      "You are a screenplay critic. Respond with ONLY a JSON object matching this schema:",
      CRITIC_PROMPT_SCHEMA_HINT,
      "",
      `SCREENPLAY ${screenplay.id}: ${screenplay.title}`,
      `LOGLINE: ${screenplay.logline}`,
    ];
    for (const scene of screenplay.scenes) {
      lines.push(`SCENE ${scene.index} [${scene.heading}] (~${scene.plannedDurationSeconds}s)`);
      lines.push(`ACTION: ${scene.action}`);
      scene.dialogue.forEach((d, i) => lines.push(`LINE ${i + 1} ${d.character}: ${d.text}`));
    }
    for (const sheet of context.characters ?? []) {
      lines.push(
        `CHARACTER ${sheet.name}: voice=${sheet.voiceDescription ?? "-"}; physical=${sheet.physicalDescription ?? "-"}`,
      );
    }
    for (const note of context.continuityNotes ?? []) lines.push(`CONTINUITY: ${note}`);
    return lines.join("\n");
  }

  async critique(screenplay: Screenplay, context: CriticContext = {}): Promise<ScriptCritique> {
    const prompt = this.buildPrompt(screenplay, context);
    const raw = await this.complete(prompt);
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(raw);
    } catch (err) {
      throw new CriticSchemaError(
        `critic model ${this.id} returned non-JSON output: ${(err as Error).message}`,
      );
    }
    return parseCritique(parsedUnknown, {
      expectedScreenplayId: screenplay.id,
      reviseOnSeverity: this.reviseOnSeverity,
    });
  }
}

/** Category code prefixes used in finding ids (re-exported for DIR-007). */
export const CRITIC_CATEGORY_CODES: Readonly<Record<CriticCategory, string>> = {
  pacing: "PAC",
  continuity: "CON",
  dialogue: "DIA",
  "character-consistency": "CHA",
};