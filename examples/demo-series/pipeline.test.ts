/**
 * REL-003 demo-series integration walk — the full NON-PAID pipeline for
 * episode S01E01 "The Overdue Room", driven end to end from the fixtures.
 *
 * Everything that would cost money is proven WITHOUT spending it:
 *  - director-model transport is the in-process mock;
 *  - storyboard frames come from MockImageClient (kind "mock");
 *  - assertPaidGenerationAllowed is exercised as the FAIL-CLOSED gate: it
 *    throws on the DRAFT plan and passes only after gate-4 approval;
 *  - the cost-engine reservation is kind "included" — tracked, but by
 *    contract never counted as paid spend against the $25 gate (spec §4);
 *  - no real provider (image or video) is ever called.
 *
 * Gate order follows spec §3 exactly: concept → script → character →
 * storyboard → rough-cut → canon (the store enforces this at every approve).
 *
 * Story text is untrusted data (spec §29): stored verbatim, never parsed
 * for instructions, never executed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalStore,
  GATE_IDS,
} from "@mmcs/core";
import {
  AssetRepository,
  CharacterRepository,
  MIGRATIONS,
  SqliteEpisodeRepository,
  SqliteProjectRepository,
  SqliteSeriesRepository,
  connectSqlite,
  formatEpisodeCode,
  migrate,
  type SqliteDatabase,
} from "@mmcs/database";
import { CostLedger, createCostEngineSchema } from "@mmcs/cost-engine";
import {
  QC_CHECK_IDS,
  parseShotQcResult,
  passedCheck,
  rollupVerdict,
} from "@mmcs/qc";
import {
  buildEpisodeCompositionRegistry,
  getCompositionForEpisode,
} from "@mmcs/remotion-runtime";
import { assembleRoughCut } from "../../packages/remotion-runtime/src/rough-cut/assemble.js";
import {
  applySelection,
  generateCandidates,
  startCandidateFlow,
} from "../../packages/character-library/src/candidates/candidate-flow.js";
import { CharacterLockService } from "../../packages/character-library/src/locking/service.js";
import { createSeriesBible, addEpisodeSummary } from "../../packages/character-library/src/series-bible/bible.js";
import {
  proposeEndOfEpisodeChanges as proposeChanges,
  approveAllProposedChanges as approveAllProposed,
} from "../../packages/character-library/src/canon-approval/canon-approval.js";

import {
  DEMO_CHARACTER_VERSIONS,
  DEMO_CONCEPT_RESPONSE_BODY,
  DEMO_IMAGE_PROFILE,
  DEMO_INTAKE,
  DEMO_KEYFRAME_PROFILE,
  DEMO_KNOWN_CHARACTERS,
  DEMO_PLANNED_SCENES,
  DEMO_REFERENCE_CAPABILITY,
  DEMO_SCENE_MASTER_INPUTS,
  DEMO_SCREENPLAY,
  DEMO_VIDEO_MODEL,
} from "./fixtures.js";

/* ------------------------------------------------------------------ */
/* Scene-intelligence deep imports (the root barrel re-exports only    */
/* concept + intake; every other submodule needs a deep path)          */
/* ------------------------------------------------------------------ */
import { parseIntake } from "../../packages/scene-intelligence/src/intake/parse.js";
import { prepareDirectorModel } from "../../packages/scene-intelligence/src/concept/director-model.js";
import { generateConcept } from "../../packages/scene-intelligence/src/concept/generator.js";
import { parseScreenplay } from "../../packages/scene-intelligence/src/scene-parser/index.js";
import { estimateRuntime } from "../../packages/scene-intelligence/src/runtime-estimator/index.js";
import { planEpisodeShots } from "../../packages/scene-intelligence/src/shot-planner/shot-planner.js";
import {
  approveSceneMasterSpec,
  classifySceneMasterNeed,
  planSceneMasters,
  type SceneMasterSpec,
} from "../../packages/scene-intelligence/src/scene-master/index.js";
import { planKeyframes } from "../../packages/scene-intelligence/src/keyframe-planner/index.js";
import { planReferenceBudget } from "../../packages/scene-intelligence/src/reference-budget/index.js";
import {
  MockImageClient,
  planStoryboard,
  generateStoryboardFrames,
  storyboardAssetId,
  type StoryboardShotInput,
} from "../../packages/scene-intelligence/src/storyboard/index.js";
import {
  approveStoryboardPlan,
  assertPaidGenerationAllowed,
} from "../../packages/scene-intelligence/src/storyboard/approval/index.js";

const NOW = "2026-08-29T00:00:00.000Z";

let tmp: string;
let db: SqliteDatabase;
let gates: ApprovalStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mmcs-demo-"));
  db = connectSqlite({ path: ":memory:" });
  migrate(db, MIGRATIONS);
  gates = new ApprovalStore(tmp);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Deterministic canon-at-the-time appearance resolver (demo cast)     */
/* ------------------------------------------------------------------ */
function resolveAppearance(characterId: string) {
  if (characterId === DEMO_CHARACTER_VERSIONS.mona.characterId) {
    return {
      identityVersion: DEMO_CHARACTER_VERSIONS.mona.identityVersion,
      hairVersion: DEMO_CHARACTER_VERSIONS.mona.hairVersion,
      wardrobeVersion: DEMO_CHARACTER_VERSIONS.mona.wardrobeVersion,
    };
  }
  if (characterId === DEMO_CHARACTER_VERSIONS.juno.characterId) {
    return {
      identityVersion: DEMO_CHARACTER_VERSIONS.juno.identityVersion,
      wardrobeVersion: DEMO_CHARACTER_VERSIONS.juno.wardrobeVersion,
    };
  }
  if (characterId === DEMO_CHARACTER_VERSIONS.smudge.characterId) {
    return {
      identityVersion: DEMO_CHARACTER_VERSIONS.smudge.identityVersion,
      wardrobeVersion: DEMO_CHARACTER_VERSIONS.smudge.wardrobeVersion,
    };
  }
  return undefined;
}

describe("demo series — non-paid pipeline (S01E01)", () => {
  it("walks every non-paid pipeline stage end to end", async () => {
    /* -------------------------------------------------------------- */
    /* 0. Persisted series + episode (what `mmcs create-series`/       */
    /*    `create-episode` create; see cli.test.ts for the verbs)      */
    /* -------------------------------------------------------------- */
    const projects = new SqliteProjectRepository(db);
    const seriesRepo = new SqliteSeriesRepository(db);
    const episodes = new SqliteEpisodeRepository(db);
    const project = projects.create({
      name: "Hollow Pine Library",
      aspectRatio: "16:9",
    });
    const series = seriesRepo.create({
      projectId: project.id,
      name: "Mona & the Brass Key",
      aspectRatio: "16:9",
    });
    const episode = episodes.create({
      projectId: project.id,
      seriesId: series.id,
      seasonNumber: 1,
      episodeNumber: 1,
      title: "The Overdue Room",
    });
    expect(episode.seasonNumber).toBe(1);
    expect(episode.episodeNumber).toBe(1);
    const code = formatEpisodeCode(1, 1);
    expect(code).toBe("S01E01");

    /* -------------------------------------------------------------- */
    /* 1. Gate 1 — intake parse + concept via the MOCK transport       */
    /* -------------------------------------------------------------- */
    const intake = parseIntake(DEMO_INTAKE);
    expect(intake.intakeId).toBe(DEMO_INTAKE.intakeId);

    const client = prepareDirectorModel({
      connection: {
        modelId: "z-ai/glm-5.3-flash",
        baseUrl: "http://mock.director.invalid",
        apiKey: "test-key-not-a-secret",
      },
      transport: {
        kind: "mock",
        request: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(DEMO_CONCEPT_RESPONSE_BODY),
              },
            },
          ],
        }),
      },
    });
    // The validator requires EXACTLY the requested option count — the
    // fixture carries two, so the request pins optionCount to two.
    const concept = await generateConcept({ intake, client, optionCount: 2 });
    const recommended = concept.options.find((o) => o.recommended);
    expect(concept.options).toHaveLength(2);
    expect(recommended?.title).toBe("The Overdue Room");
    expect(recommended?.suggestedEpisodeCount).toBe(3);

    /* -------------------------------------------------------------- */
    /* 2. Gates 1+2 — concept + script approvals                       */
    /* -------------------------------------------------------------- */
    await gates.load();
    await gates.approve("concept", {
      decidedBy: "demo-operator",
      note: "Recommended option: The Overdue Room",
    });
    await gates.approve("script", {
      decidedBy: "demo-operator",
      note: "Two-scene pilot script approved",
    });

    /* -------------------------------------------------------------- */
    /* 3. Gate 2 — screenplay parse + runtime estimate                 */
    /* -------------------------------------------------------------- */
    const parsed = parseScreenplay(DEMO_SCREENPLAY, {
      approved: true,
      knownCharacters: [...DEMO_KNOWN_CHARACTERS],
    });
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.warnings).toEqual([]);

    const screenplayForEstimator = {
      id: "SCRIPT_S01E01",
      title: "The Overdue Room",
      scenes: parsed.scenes.map((s) => ({
        id: s.sceneId,
        title: s.name,
        elements: [
          ...s.actionLines.map((text) => ({ kind: "action" as const, text })),
          ...s.dialogue.map((d) => ({
            kind: "dialogue" as const,
            text: d.text,
            character: d.character,
          })),
        ],
      })),
    };
    const runtime = estimateRuntime(screenplayForEstimator);
    expect(runtime.totalSeconds).toBeGreaterThan(0);
    expect(runtime.estimatorVersion).toBe("runtime-estimator/1");
    expect(runtime.perScene).toHaveLength(2);

    /* -------------------------------------------------------------- */
    /* 4. Shot planning (Agnes 4–12s window)                           */
    /* -------------------------------------------------------------- */
    const plannedShots = planEpisodeShots(DEMO_PLANNED_SCENES, {
      model: DEMO_VIDEO_MODEL,
    });
    expect(plannedShots.map((s) => s.sceneId)).toEqual(["SC01", "SC02"]);
    const shots = plannedShots.flatMap((s) => s.shots);
    expect(shots).toHaveLength(9);
    expect(shots.map((s) => s.shot_id)).toEqual([
      "SC01_SH01",
      "SC01_SH02",
      "SC01_SH03",
      "SC01_SH04",
      "SC01_SH05",
      "SC02_SH01",
      "SC02_SH02",
      "SC02_SH03",
      "SC02_SH04",
    ]);
    for (const shot of shots) {
      expect(shot.target_duration).toBeGreaterThanOrEqual(4);
      expect(shot.target_duration).toBeLessThanOrEqual(12);
      expect(shot.preferred_model).toBe(DEMO_VIDEO_MODEL.modelId);
      expect(shot.character_versions.length).toBeGreaterThan(0);
    }
    expect(plannedShots[0]?.warnings).toEqual([]);
    // SC02 carries 4 beats against a 5-shot pace target — the planner clamps
    // and records a non-fatal warning instead of inventing a hollow shot.
    expect(plannedShots[1]?.warnings).toHaveLength(1);

    /* -------------------------------------------------------------- */
    /* 5. Scene masters — classify, then plan ONE scene per call       */
    /*    (shared positions batch would throw across different casts)  */
    /* -------------------------------------------------------------- */
    for (const entry of DEMO_SCENE_MASTER_INPUTS) {
      const need = classifySceneMasterNeed({
        sceneId: entry.sceneId,
        characters: entry.characters,
        speakingCharacters: entry.speakingCharacters,
        importance: entry.importance,
      });
      expect(need.requiresSceneMaster).toBe(true);
    }

    const sceneMasterSpecs: SceneMasterSpec[] = [];
    const sceneMasterMeta = [
      {
        locationId: "LOC_LIBRARY_READING_ROOM",
        roomName: "Hollow Pine Library — Reading Room",
        scheme: "moonlight stripes, warm desk lamp",
        notes: "Moonlit reading room, ledger desk, loose floorboard",
      },
      {
        locationId: "LOC_LIBRARY_OVERDUE_ROOM",
        roomName: "The Overdue Room",
        scheme: "floating shelf-glow, cool key light",
        notes: "Floating bookshelves with glowing date stamps",
      },
    ];
    for (const [i, entry] of DEMO_SCENE_MASTER_INPUTS.entries()) {
      const meta = sceneMasterMeta[i]!;
      const [plan] = planSceneMasters(
        [
          {
            sceneId: entry.sceneId,
            characters: entry.characters,
            speakingCharacters: entry.speakingCharacters,
            importance: entry.importance,
          },
        ],
        {
          locationId: meta.locationId,
          roomName: meta.roomName,
          timeOfDay: "night",
          environmentNotes: meta.notes,
        },
        { scheme: meta.scheme },
        [
          { name: "brass key", handledByCharacterId: DEMO_CHARACTER_VERSIONS.mona.characterId },
          ...(entry.sceneId === "SC02"
            ? [{ name: "the Cartographer's Daughter" }]
            : []),
        ],
        entry.characters.map((characterId, idx) => ({
          characterId,
          position: (idx === 0 ? "center" : "center-right") as
            | "center"
            | "center-right",
          facing: "camera" as const,
        })),
        { resolveAppearance },
      );
      expect(plan?.requiresSceneMaster).toBe(true);
      const spec = plan?.spec;
      expect(spec?.sceneId).toBe(entry.sceneId);
      const approvedSpec = approveSceneMasterSpec(spec!);
      expect(approvedSpec.approvalState).toBe("APPROVED");
      expect(approvedSpec.providerReferenceEligible).toBe(true);
      sceneMasterSpecs.push(approvedSpec);
    }
    expect(sceneMasterSpecs.map((s) => s.sceneId)).toEqual(["SC01", "SC02"]);

    /* -------------------------------------------------------------- */
    /* 6. Keyframe planning (DIR-012)                                  */
    /* -------------------------------------------------------------- */
    const keyframes = planKeyframes(
      shots.map((s) => ({
        shotId: s.shot_id,
        sceneId: s.scene_id,
        characters: s.characters,
        shotType: s.camera_angle,
        sceneMasterAvailable: true,
      })),
      DEMO_KEYFRAME_PROFILE,
      { modelLabel: DEMO_VIDEO_MODEL.modelId },
    );
    expect(keyframes.decisions).toHaveLength(9);
    for (const decision of keyframes.decisions) {
      expect(decision.shotId).toMatch(/^SC0\d_SH0\d$/);
      expect(decision.keyframeCount).toBeGreaterThanOrEqual(0);
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.downgraded).toEqual([]); // profile supports everything
    }

    /* -------------------------------------------------------------- */
    /* 7. Reference budget — minimum-sufficient pack per shot          */
    /* -------------------------------------------------------------- */
    const assetIdFor = (name: string) => `ASSET_DEMO_${name}`;
    const candidates = [
      {
        assetId: assetIdFor("MONA_IDENTITY"),
        characterId: DEMO_CHARACTER_VERSIONS.mona.characterId,
        kind: "identity" as const,
        valueProfile: {
          identity: 0.95, wardrobe: 0.9, pose: 0.7, startState: 0.6,
          endState: 0.5, prop: 0.0, location: 0.0,
        },
      },
      {
        assetId: assetIdFor("JUNO_IDENTITY"),
        characterId: DEMO_CHARACTER_VERSIONS.juno.characterId,
        kind: "identity" as const,
        valueProfile: {
          identity: 0.95, wardrobe: 0.9, pose: 0.7, startState: 0.6,
          endState: 0.5, prop: 0.0, location: 0.0,
        },
      },
      {
        assetId: assetIdFor("SMUDGE_IDENTITY"),
        characterId: DEMO_CHARACTER_VERSIONS.smudge.characterId,
        kind: "identity" as const,
        valueProfile: {
          identity: 0.95, wardrobe: 0.9, pose: 0.7, startState: 0.6,
          endState: 0.5, prop: 0.0, location: 0.0,
        },
      },
      {
        assetId: assetIdFor("LOC_READING_ROOM"),
        kind: "location" as const,
        valueProfile: { location: 1 },
      },
      {
        assetId: assetIdFor("LOC_OVERDUE_ROOM"),
        kind: "location" as const,
        valueProfile: { location: 1 },
      },
      {
        assetId: assetIdFor("PROP_BRASS_KEY"),
        kind: "prop" as const,
        valueProfile: { prop: 1 },
      },
    ];

    type BudgetPlan = Awaited<ReturnType<typeof planReferenceBudget>>;
    const budgets: BudgetPlan[] = [];
    for (const shot of shots) {
      const master = sceneMasterSpecs.find((m) => m.sceneId === shot.scene_id)!;
      const budget = await planReferenceBudget({
        shotId: shot.shot_id,
        shotType: shot.camera_angle,
        characters: shot.characters,
        sceneMaster: {
          assetId: assetIdFor(`SCM_${master.sceneId}`),
          approved: true,
          valueProfile: {
            identity: 1, wardrobe: 1, location: 1, prop: 1, pose: 0.9,
            startState: 0.6, endState: 0.6,
          },
        },
        candidates,
        capability: DEMO_REFERENCE_CAPABILITY,
        model: DEMO_VIDEO_MODEL.modelId,
      });
      budgets.push(budget);
    }
    for (const budget of budgets) {
      expect(budget.referenceIds.length).toBeGreaterThan(0);
      expect(budget.underLimit).toBe(true);
      expect(budget.notes.length).toBeGreaterThan(0);
    }

    /* -------------------------------------------------------------- */
    /* 8. Storyboard plan + DRAFT-state frames (MockImageClient)       */
    /* -------------------------------------------------------------- */
    const mappedStrategy = (raw: string): StoryboardShotInput["keyframeStrategy"] => {
      switch (raw) {
        case "start-keyframe": return "one-starting-keyframe";
        case "scene-master-references": return "scene-master-plus-references";
        case "zero-keyframes": return "zero-keyframes";
        case "start-end-keyframes": return "start-end-keyframes";
        default: return raw as StoryboardShotInput["keyframeStrategy"];
      }
    };

    const storyboardShots: StoryboardShotInput[] = shots.map((s) => ({
      shotId: s.shot_id,
      sceneId: s.scene_id,
      episodeCode: code,
      shotType: s.camera_angle,
      visualIntent: s.action,
      characters: s.characters,
      keyframeStrategy: mappedStrategy(s.keyframe_strategy),
      referenceAssetIds:
        budgets.find((b) => b.shotId === s.shot_id)?.referenceIds ?? [],
      sceneMasterAvailable: true,
    }));

    const plan = planStoryboard(storyboardShots, [DEMO_IMAGE_PROFILE], {
      aspectRatio: "16:9",
    });
    expect(plan.contracts).toHaveLength(9);
    for (const contract of plan.contracts) {
      expect(contract.assetId).toBe(storyboardAssetId(code, contract.shotId));
      expect(contract.imageModel.modelId).toBe(DEMO_IMAGE_PROFILE.modelId);
      expect(contract.output.aspectRatio).toBe("16:9");
      expect(contract.prompt.length).toBeGreaterThan(0);
      expect(contract.providerInput).toBe(false);
      expect(contract.usageMarker).toBe("NON_PROVIDER_INPUT");
    }
    expect(plan.approvalState).toBe("DRAFT");

    const mockClient = new MockImageClient();
    expect(mockClient.kind).toBe("mock");
    const frames = await generateStoryboardFrames(plan, mockClient);
    expect(frames).toHaveLength(9);
    for (const frame of frames) {
      expect(frame.assetId.startsWith("ASSET_S01E01_")).toBe(true);
      expect(frame.providerInput).toBe(false);
    }
    // Frames are produced in contract order — zip them for the manifest.
    expect(frames.map((f) => f.assetId)).toEqual(plan.contracts.map((c) => c.assetId));

    /* -------------------------------------------------------------- */
    /* 9. Fail-closed gate 4 — DRAFT plan + PENDING gate throws        */
    /*    (mock client stays legal; this is the PAID-path check)      */
    /* -------------------------------------------------------------- */
    const draftSnapshot = await gates.snapshot("storyboard");
    expect(draftSnapshot.state).toBe("PENDING");
    expect(() =>
      assertPaidGenerationAllowed({ plan, gate: draftSnapshot }),
    ).toThrow();

    /* -------------------------------------------------------------- */
    /* 10. Gate 3 — candidates + LOCK CHARACTER (Mona) BEFORE gate 4   */
    /*     (the store enforces character → storyboard order, spec §3) */
    /* -------------------------------------------------------------- */
    const characters = new CharacterRepository(db);
    characters.create({
      characterId: DEMO_CHARACTER_VERSIONS.mona.characterId,
      displayName: "Mona",
      state: "DRAFT",
    });
    let flow = startCandidateFlow(
      {
        characterId: DEMO_CHARACTER_VERSIONS.mona.characterId,
        displayName: "Mona",
        seriesId: series.id,
        episodeId: episode.id,
        brief: "Small grey library cat, collar with brass tag",
        requestedAt: NOW,
      },
      NOW,
    );
    const generated = generateCandidates(flow, NOW);
    flow = generated.state;
    expect(generated.candidates).toHaveLength(3);
    expect(generated.candidates.every((c) => c.state === "REVIEW")).toBe(true);

    flow = applySelection(flow, "1", NOW, "demo picks design 1");
    const chosen = flow.candidates.find((c) => c.slot === 1);
    expect(chosen?.state).toBe("APPROVED");
    // Unselected candidates are terminal — they can never lock.
    expect(
      flow.candidates.filter((c) => c.state === "REJECTED"),
    ).toHaveLength(2);

    // The character record must be APPROVED before LOCK (spec §3 order).
    characters.update(DEMO_CHARACTER_VERSIONS.mona.characterId, {
      state: "APPROVED",
    });

    await gates.approve("character", {
      decidedBy: "demo-operator",
      note: "Mona candidate design 1 approved — lock her",
    });

    // Honest snapshot: read AFTER the approval, exactly what the store wrote.
    const characterSnap = await gates.snapshot("character");
    expect(characterSnap.state).toBe("APPROVED");

    // Only the APPROVED candidate enters the lock — REJECTED candidates are
    // terminal (spec §9) and assertCanonicalizable throws on any of them.
    const lockAssets = flow.candidates
      .filter((c) => c.state === "APPROVED")
      .map((c) => ({
        assetId: c.candidateId,
        characterId: c.characterId,
        state: c.state,
      }));
    expect(lockAssets).toHaveLength(1);

    const lockService = new CharacterLockService({
      gateReader: {
        characterGate: () => characterSnap,
      },
      characters: {
        get: (id) => {
          const rec = characters.findById(id);
          return rec ? { characterId: rec.characterId, state: rec.state } : null;
        },
        setState: (id, state) => {
          characters.update(id, { state });
        },
      },
      assets: {
        listByCharacter: () => lockAssets,
        setState: (assetId, state) => {
          const target = lockAssets.find((a) => a.assetId === assetId);
          if (target) target.state = state;
        },
      },
    });
    const lockResult = lockService.lock(
      DEMO_CHARACTER_VERSIONS.mona.characterId,
      NOW,
    );
    expect(lockResult.characterState).toBe("CANONICAL");
    expect(lockResult.lockedAssetIds).toHaveLength(1);
    expect(
      lockResult.events.some((e) => e.kind === "CHARACTER_TO_CANONICAL"),
    ).toBe(true);
    expect(characters.findById(DEMO_CHARACTER_VERSIONS.mona.characterId)?.state).toBe(
      "CANONICAL",
    );

    /* -------------------------------------------------------------- */
    /* 11. Gate 4 — storyboard approval (after character, per §3)      */
    /* -------------------------------------------------------------- */
    const approved = await approveStoryboardPlan(plan, gates, {
      decidedBy: "demo-operator",
      note: "Demo storyboards approved",
    });
    expect(approved.plan.approvalState).toBe("APPROVED");
    expect(approved.snapshot.gate).toBe("storyboard");
    expect(approved.snapshot.state).toBe("APPROVED");

    const snapG4 = await gates.snapshot("storyboard");
    expect(() =>
      assertPaidGenerationAllowed({ plan: approved.plan, gate: snapG4 }),
    ).not.toThrow();

    /* -------------------------------------------------------------- */
    /* 12. Cost engine — "included" reservation, gate untouched        */
    /* -------------------------------------------------------------- */
    createCostEngineSchema(db);
    const ledger = new CostLedger(db, { limitUsd: 25 });
    const decision = ledger.reserve({
      provider: DEMO_VIDEO_MODEL.provider,
      providerModel: DEMO_VIDEO_MODEL.modelId,
      estimatedUsd: 1.25,
      kind: "included",
      episodeId: episode.id,
      requestedSeconds: 54,
    });
    expect(decision.outcome).toBe("approved");
    const reservation = decision.reservation!;
    expect(reservation.kind).toBe("included");
    expect(reservation.status).toBe("reserved");
    const committed = ledger.commit(reservation.id, 0);
    expect(committed.status).toBe("committed");
    expect(committed.actualUsd).toBe(0); // included-kind — never real spend
    expect(ledger.summary().projectedTotalUsd).toBe(0);

    /* -------------------------------------------------------------- */
    /* 13. QC — all 17 checks, schema-valid per-shot result            */
    /* -------------------------------------------------------------- */
    const checks = QC_CHECK_IDS.map((id) =>
      passedCheck(id, `demo walk: ${id} observed clean on ${shots[0]!.shot_id}`),
    );
    expect(checks).toHaveLength(17);
    expect(rollupVerdict(checks)).toBe("PASS");
    const qcResult = parseShotQcResult({
      schemaVersion: 1,
      seriesId: series.id,
      episodeId: episode.id,
      sceneId: "SC01",
      shotId: shots[0]!.shot_id,
      assetId: frames[0]!.assetId,
      route: "video-direct",
      reviewedBy: "demo-walkthrough",
      checks,
      startedAt: NOW,
      completedAt: NOW,
      verdict: rollupVerdict(checks),
      attempt: 0,
    });
    expect(qcResult.verdict).toBe("PASS");

    /* -------------------------------------------------------------- */
    /* 14. Rough cut + episodic composition registry                   */
    /* -------------------------------------------------------------- */
    const episodeWideIndex = new Map(
      shots.map((shot, i) => [shot.shot_id, i + 1]),
    );
    const roughCut = assembleRoughCut({
      formatVersion: 1,
      seriesId: series.id,
      episodeId: episode.id,
      episodeCode: code,
      format: "16:9",
      shots: shots.map((shot) => ({
        shotId: shot.shot_id,
        sequenceIndex: episodeWideIndex.get(shot.shot_id)!,
        targetDurationSeconds: shot.target_duration,
        layerKind: "generated-video" as const,
        assetRef: `mock://demo/${storyboardAssetId(code, shot.shot_id)}`,
      })),
      dialogue: [
        {
          dialogueId: "DLG_001",
          assetKey: "asset:demo:mona-line-1",
          startSec: 14,
          durationSec: 4,
          shotId: "SC01_SH03",
        },
        {
          dialogueId: "DLG_002",
          assetKey: "asset:demo:juno-line-1",
          startSec: 38,
          durationSec: 3,
          shotId: "SC02_SH02",
        },
      ],
      tempMusic: { assetRef: "mock://demo/music-bed", gainDb: -18 },
    });
    expect(roughCut.segments).toHaveLength(9);
    expect(roughCut.format).toBe("16:9");
    expect(roughCut.resolution).toEqual({ width: 1920, height: 1080 });
    expect(roughCut.totalFrames).toBeGreaterThan(0);
    // Dialogue is PLACED on the master timeline (30 fps default).
    expect(roughCut.dialogue).toHaveLength(2);
    expect(roughCut.dialogue[0]).toEqual({
      dialogueId: "DLG_001",
      assetKey: "asset:demo:mona-line-1",
      startFrame: 420,
      durationFrames: 120,
      sourceSec: 14,
    });
    expect(roughCut.dialogue[1]?.startFrame).toBe(1140);
    expect(roughCut.tempMusic).toEqual({
      assetRef: "mock://demo/music-bed",
      gainDb: -18,
    });
    // 30 + 24 = 54 planned seconds land on the timeline
    expect(roughCut.durationSeconds).toBeCloseTo(54, 5);

    const registry = buildEpisodeCompositionRegistry({
      series: {
        id: series.id,
        title: series.name,
        fps: 24,
        width: 1920,
        height: 1080,
      },
      episodes: [
        {
          id: episode.id,
          seasonNumber: 1,
          episodeNumber: 1,
          scenes: DEMO_PLANNED_SCENES.map((scene, i) => ({
            sceneId: scene.sceneId,
            sequenceIndex: i + 1, // registry demands positive integers
            shots: plannedShots[i]!.shots.map((shot) => ({
              shotId: shot.shot_id,
              sequenceIndex: shot.sequence_index,
              targetDurationSeconds: shot.target_duration,
            })),
          })),
        },
      ],
    });
    const composition = getCompositionForEpisode(registry, "S01E01");
    expect(composition.compositionId).toBe("S01E01");
    expect(composition.durationInFrames).toBe(54 * 24);

    /* -------------------------------------------------------------- */
    /* 15. Asset manifest — register mock frames, flip QC to PASSED    */
    /* -------------------------------------------------------------- */
    const assets = new AssetRepository(db);
    for (const [i, contract] of plan.contracts.entries()) {
      const frame = frames[i]!;
      assets.create({
        assetId: contract.assetId,
        seriesId: series.id,
        episodeId: episode.id,
        sceneId: contract.sceneId,
        shotId: contract.shotId,
        assetType: "storyboard-frame",
        assetState: "DRAFT", // planning art, pre-generation
        provider: frame.provider,
        providerModel: frame.modelId,
        approvalState: "PENDING",
        qcState: "PENDING",
        createdAt: NOW,
      });
      const updated = assets.update(contract.assetId, { qcState: "PASSED" });
      expect(updated?.qcState).toBe("PASSED");
    }
    expect(assets.list().filter((a) => a.qcState === "PASSED")).toHaveLength(9);

    /* -------------------------------------------------------------- */
    /* 16. Rough-cut gate (gate 5) before canon                        */
    /* -------------------------------------------------------------- */
    await gates.approve("rough-cut", {
      decidedBy: "demo-operator",
      note: "Rough-cut timeline reviewed",
    });

    /* -------------------------------------------------------------- */
    /* 17. Series bible + end-of-episode canon under gate 6            */
    /* -------------------------------------------------------------- */
    const bible = createSeriesBible({
      seriesId: series.id,
      title: series.name,
      premise: recommended?.premise,
    });
    addEpisodeSummary(bible, {
      episode: code,
      title: "The Overdue Room",
      summary:
        "Mona finds the brass key and meets Smudge in the Overdue Room; " +
        "she steps toward the floating shelves as the door begins to close at dawn.",
    });
    const proposed = proposeChanges(bible, {
      episode: code,
      proposedAt: NOW,
      drafts: [
        {
          description: "The Overdue Room keeps only what is read aloud.",
          mutations: [
            {
              op: "add_world_rule",
              rule: {
                ruleId: "RULE_READ_ALOUD",
                statement: "The room only keeps what is read aloud.",
              },
            },
            {
              op: "add_prop",
              prop: {
                propId: "PROP_CARTOGRAPHERS_DAUGHTER",
                name: "The Cartographer's Daughter",
                notes: "The story Juno lost.",
              },
            },
          ],
        },
      ],
    });
    expect(proposed.entries).toHaveLength(1);

    await gates.approve("canon", {
      decidedBy: "demo-operator",
      note: "S01E01 end-of-episode changes approved",
    });
    const canonSnapshot = await gates.snapshot("canon");
    expect(canonSnapshot.state).toBe("APPROVED");
    const proposedChange = proposed.entries[0]!.change;
    // Batch approve behind gate 6 — atomically dry-runs then stamps
    // sequential canonVersions (the one-binding interop path vitest handles).
    const approvedChanges = approveAllProposed(bible, {
      gate: canonSnapshot,
      decidedAt: NOW,
    });
    expect(approvedChanges).toHaveLength(1);
    const approvedChange = approvedChanges[0]!;
    expect(approvedChange.status).toBe("APPROVED");
    expect(approvedChange.canonVersion).toBe(1);
    expect(bible.canonChanges[0]?.status).toBe("APPROVED");

    /* -------------------------------------------------------------- */
    /* 18. All six gates APPROVED — gate order held end to end         */
    /* -------------------------------------------------------------- */
    const snaps = await gates.snapshots();
    const stateByGate = new Map(snaps.map((s) => [s.gate, s.state]));
    for (const g of GATE_IDS) {
      expect(stateByGate.get(g)).toBe("APPROVED");
    }
  });
});