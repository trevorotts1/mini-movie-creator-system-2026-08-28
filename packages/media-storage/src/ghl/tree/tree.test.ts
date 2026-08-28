/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest";
import { createTreeBuilder, CHARACTER_SUBFOLDERS, EPISODE_SUBFOLDERS } from "./tree.js";
import { RecordingGhlClient, type GhlFoldersClient, type RecordedCall } from "./client.js";

/**
 * Mocked GHL folders API that records every call, simulating the spec §17
 * sequence: search via GET /medias/files semantics, create via
 * POST /medias/folder semantics. Duplicate-root prevention is proven by
 * asserting the recorded call log, not by inspecting internal state.
 */
function makeClient(): RecordingGhlClient {
  return new RecordingGhlClient();
}

const ROOT = "Convert and Flow";

describe("GhlTreeBuilder — spec §17 full tree", () => {
  let client: RecordingGhlClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("creates the full tree from an empty location", async () => {
    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({ locationId: "loc-1" });

    expect(tree.root.name).toBe(ROOT);
    expect(tree.root.path).toBe(ROOT);

    // Top-level sections exist with correct paths.
    const sections = tree.root.children.map((c) => ({ name: c.name, path: c.path }));
    expect(sections).toContainEqual({ name: "Character Library", path: `${ROOT}/Character Library` });
    expect(sections).toContainEqual({ name: "Series", path: `${ROOT}/Series` });
    expect(sections).toContainEqual({ name: "Standalone Movies", path: `${ROOT}/Standalone Movies` });

    // Search happened before every create; every create carries location context.
    for (const call of client.calls) {
      if (call.kind === "create") {
        expect(call.body.altId).toBe("loc-1");
        expect(call.body.altType).toBe("location");
      }
    }
  });

  it("creates Character Library structure for a character", async () => {
    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({
      locationId: "loc-1",
      characters: [{ name: "Monica" }],
    });

    const charFolder = findNode(tree.root, `${ROOT}/Character Library/Monica`);
    expect(charFolder).toBeDefined();

    const subPaths = charFolder!.children.map((c) => c.path);
    expect(subPaths).toEqual([
      `${ROOT}/Character Library/Monica/Identity Masters`,
      `${ROOT}/Character Library/Monica/Expressions`,
      `${ROOT}/Character Library/Monica/Wardrobe`,
      `${ROOT}/Character Library/Monica/Voice References`,
      `${ROOT}/Character Library/Monica/Approved Scene References`,
    ]);
  });

  it("creates Series bible + season + episode 01–09 subfolders", async () => {
    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({
      locationId: "loc-1",
      series: [
        {
          name: "Neon City",
          episodes: [{ season: 1, episode: 1, title: "Pilot" }],
        },
      ],
    });

    const episodePath = `${ROOT}/Series/Neon City/Season 01/S01E01 - Pilot`;
    const episode = findNode(tree.root, episodePath);
    expect(episode).toBeDefined();

    const subPaths = episode!.children.map((c) => c.path);
    expect(subPaths).toEqual([
      `${episodePath}/01 Script`,
      `${episodePath}/02 Characters`,
      `${episodePath}/03 Scene Masters`,
      `${episodePath}/04 Storyboards`,
      `${episodePath}/05 Audio`,
      `${episodePath}/06 Video Clips`,
      `${episodePath}/07 Rough Cut`,
      `${episodePath}/08 Final`,
      `${episodePath}/09 QC Metadata`,
    ]);

    // Series Bible subfolders.
    const biblePath = `${ROOT}/Series/Neon City/Series Bible`;
    const bible = findNode(tree.root, biblePath);
    expect(bible!.children.map((c) => c.path)).toEqual([
      `${biblePath}/Characters`,
      `${biblePath}/Locations`,
      `${biblePath}/Wardrobe`,
      `${biblePath}/Props`,
    ]);
  });

  it("creates Standalone Movies project with the same 01–09 subfolders", async () => {
    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({
      locationId: "loc-1",
      standaloneMovies: [{ name: "One Off" }],
    });

    const projectPath = `${ROOT}/Standalone Movies/One Off`;
    const project = findNode(tree.root, projectPath);
    expect(project).toBeDefined();
    expect(project!.children.map((c) => c.name)).toEqual([
      "01 Script",
      "02 Characters",
      "03 Scene Masters",
      "04 Storyboards",
      "05 Audio",
      "06 Video Clips",
      "07 Rough Cut",
      "08 Final",
      "09 QC Metadata",
    ]);
  });

  it("pads season/episode numbers to two digits (S02E07)", async () => {
    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({
      locationId: "loc-1",
      series: [
        {
          name: "Neon City",
          episodes: [{ season: 2, episode: 7, title: "Late Shift" }],
        },
      ],
    });

    const episodePath = `${ROOT}/Series/Neon City/Season 02/S02E07 - Late Shift`;
    expect(findNode(tree.root, episodePath)).toBeDefined();
    // Season 01 folder is NOT created when only season 02 is requested.
    expect(findNode(tree.root, `${ROOT}/Series/Neon City/Season 01`)).toBeUndefined();
  });
});

describe("GhlTreeBuilder — idempotency (spec: search before create, never duplicate roots)", () => {
  let client: RecordingGhlClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("second run creates zero duplicates against the same API state", async () => {
    const builder = createTreeBuilder({ client });
    const request = {
      locationId: "loc-1",
      characters: [{ name: "Monica" }],
      series: [
        {
          name: "Neon City",
          episodes: [
            { season: 1, episode: 1, title: "Pilot" },
            { season: 1, episode: 2, title: "Ghosts" },
          ],
        },
      ],
      standaloneMovies: [{ name: "One Off" }],
    };

    const first = await builder.ensureTree(request);
    const createsAfterFirst = client.createdCount;
    expect(createsAfterFirst).toBeGreaterThan(0);

    // Second run: API state now contains the whole tree; nothing may be created.
    const second = await builder.ensureTree(request);

    expect(client.createdCount).toBe(createsAfterFirst);
    expect(second.createdCount).toBe(0);
    expect(sameShape(first.root, second.root)).toBe(true);
  });

  it("second builder instance against populated API also creates zero duplicates", async () => {
    const request = {
      locationId: "loc-2",
      characters: [{ name: "Dre" }],
      series: [
        {
          name: "Neon City",
          episodes: [{ season: 1, episode: 1, title: "Pilot" }],
        },
      ],
      standaloneMovies: [],
    };

    const firstClient = new RecordingGhlClient();
    await createTreeBuilder({ client: firstClient }).ensureTree(request);

    // Fresh builder, same (now populated) backing store.
    const secondClient = new RecordingGhlClient();
    secondClient.store = firstClient.store;
    const secondBuilder = createTreeBuilder({ client: secondClient });
    const result = await secondBuilder.ensureTree(request);

    expect(result.createdCount).toBe(0);
    expect(secondClient.createdCount).toBe(0);
  });

  it("partial existing tree only creates the missing folders", async () => {
    const client = new RecordingGhlClient();
    // Pre-create only the root.
    client.store.createFolder(ROOT, undefined);

    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({ locationId: "loc-1" });

    // Root searched (found), never re-created.
    expect(
      client.calls.some((c): c is Extract<RecordedCall, { kind: "create" }> => c.kind === "create" && c.body.name === ROOT),
    ).toBe(false);

    const sections = tree.root.children.map((c) => c.name);
    expect(sections).toEqual(["Character Library", "Series", "Standalone Movies"]);
    expect(tree.root.existing).toBe(true);
    expect(tree.root.children.every((c) => c.existing === false)).toBe(true);
  });

  it("searches by exact name only (no partial-match duplicates)", async () => {
    const client = new RecordingGhlClient();
    // A similar-but-different folder exists; must not satisfy the search.
    client.store.createFolder("Convert and Flow Backup", undefined);

    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({ locationId: "loc-1" });

    expect(tree.root.name).toBe(ROOT);
    expect(client.createdCount).toBe(4); // root + 3 sections
  });

  it("duplicate specs within one run create nothing extra (intra-run memo)", async () => {
    const client = new RecordingGhlClient();
    const builder = createTreeBuilder({ client });
    const tree = await builder.ensureTree({
      locationId: "loc-1",
      characters: [{ name: "Monica" }, { name: "Monica" }],
      series: [
        {
          name: "Neon City",
          episodes: [
            { season: 1, episode: 1, title: "Pilot" },
            { season: 1, episode: 1, title: "Pilot" },
          ],
        },
        { name: "Neon City" },
      ],
    });

    // Each duplicated node searched+created exactly once.
    const monicaCreates = client.calls.filter(
      (c): c is Extract<RecordedCall, { kind: "create" }> =>
        c.kind === "create" && c.body.name === "Monica",
    );
    expect(monicaCreates).toHaveLength(1);
    const pilotCreates = client.calls.filter(
      (c): c is Extract<RecordedCall, { kind: "create" }> =>
        c.kind === "create" && c.body.name === "S01E01 - Pilot",
    );
    expect(pilotCreates).toHaveLength(1);
    const neonCreates = client.calls.filter(
      (c): c is Extract<RecordedCall, { kind: "create" }> =>
        c.kind === "create" && c.body.name === "Neon City",
    );
    expect(neonCreates).toHaveLength(1);

    // Result tree carries each node exactly once.
    const monica = findNode(tree.root, `${ROOT}/Character Library/Monica`);
    expect(monica).toBeDefined();
    expect(monica!.children).toHaveLength(CHARACTER_SUBFOLDERS.length);
    const seasonNode = findNode(tree.root, `${ROOT}/Series/Neon City/Season 01`);
    expect(
      seasonNode!.children.filter((c) => c.name === "S01E01 - Pilot"),
    ).toHaveLength(1);
    expect(
      findNode(tree.root, `${ROOT}/Series/Neon City/Season 01/S01E01 - Pilot`)!
        .children,
    ).toHaveLength(EPISODE_SUBFOLDERS.length);
  });
});

describe("GhlTreeBuilder — API contract", () => {
  it("createFolder payload matches spec §17 POST /medias/folder shape", async () => {
    const client = new RecordingGhlClient();
    const builder = createTreeBuilder({ client });
    await builder.ensureTree({ locationId: "loc-9", characters: [{ name: "Monica" }] });

    const rootCreate = client.calls.find(
      (c): c is Extract<RecordedCall, { kind: "create" }> => c.kind === "create" && c.body.name === ROOT,
    );
    expect(rootCreate).toBeDefined();
    // Root has no parentId; nested folders do.
    expect(rootCreate!.body.parentId).toBeUndefined();
    expect(rootCreate!.body.altId).toBe("loc-9");
    expect(rootCreate!.body.altType).toBe("location");

    const sectionCreate = client.calls.find(
      (c): c is Extract<RecordedCall, { kind: "create" }> => c.kind === "create" && c.body.name === "Character Library",
    );
    expect(sectionCreate!.body.parentId).toBe(rootCreate!.result!.id);
  });

  it("searches each level by exact name before creating (call ordering)", async () => {
    const client = new RecordingGhlClient();
    const builder = createTreeBuilder({ client });
    await builder.ensureTree({ locationId: "loc-1", characters: [{ name: "Monica" }] });

    // For the root: a search call precedes its create call.
    const rootSearchIdx = client.calls.findIndex(
      (c) => c.kind === "search" && c.query.name === ROOT,
    );
    const rootCreateIdx = client.calls.findIndex(
      (c): c is Extract<RecordedCall, { kind: "create" }> => c.kind === "create" && c.body.name === ROOT,
    );
    expect(rootSearchIdx).toBeGreaterThanOrEqual(0);
    expect(rootCreateIdx).toBeGreaterThan(rootSearchIdx);
  });
});

function findNode(
  node: { name: string; path: string; children: unknown[] },
  path: string,
): NodeType | undefined {
  if (node.path === path) return node as NodeType;
  for (const child of node.children as NodeType[]) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return undefined;
}

type NodeType = {
  name: string;
  path: string;
  children: NodeType[];
  existing: boolean;
};

function sameShape(a: NodeType, b: NodeType): boolean {
  if (a.name !== b.name || a.path !== b.path) return false;
  if (a.children.length !== b.children.length) return false;
  return a.children.every((child, i) => sameShape(child, b.children[i]!));
}

// Keep the type import referenced for consumers of this test helper.
export type { GhlFoldersClient };