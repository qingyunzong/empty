import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LayoutVersion,
  SubtitleLayoutEngine,
  layoutAll,
  type Subtitle,
} from "../src/index.js";

function sub(
  id: string,
  start: number,
  end: number,
  overrides: Partial<Subtitle> = {},
): Subtitle {
  return {
    id,
    start,
    end,
    x0: 0,
    x1: 100,
    lineHeight: 1,
    preferredLine: 0,
    ...overrides,
  };
}

function assertSameLines(
  actual: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  context: string,
): void {
  assert.deepEqual(
    Object.fromEntries([...actual].sort()),
    Object.fromEntries([...expected].sort()),
    context,
  );
}

function assertMatchesFullRecompute(
  engine: SubtitleLayoutEngine,
  context: string,
): void {
  assertSameLines(
    engine.currentVersion.lines,
    layoutAll(engine.subtitles),
    `${context}: incremental layout must equal full recompute`,
  );
}

describe("overlap semantics", () => {
  it("treats time intervals touching only at an endpoint as non-overlapping", () => {
    const lines = layoutAll([sub("a", 0, 10), sub("b", 10, 20)]);
    assert.equal(lines.get("a"), 0);
    assert.equal(lines.get("b"), 0);
  });

  it("treats horizontal intervals touching only at an endpoint as non-overlapping", () => {
    const lines = layoutAll([
      sub("a", 0, 10, { x0: 0, x1: 100 }),
      sub("b", 0, 10, { x0: 100, x1: 200 }),
    ]);
    assert.equal(lines.get("a"), 0);
    assert.equal(lines.get("b"), 0);
  });

  it("separates cues overlapping in both time and horizontal pixels", () => {
    const lines = layoutAll([
      sub("a", 0, 10, { x0: 0, x1: 101 }),
      sub("b", 5, 15, { x0: 100, x1: 200 }),
    ]);
    assert.equal(lines.get("a"), 0);
    assert.equal(lines.get("b"), 1);
  });
});

describe("full layout", () => {
  it("stacks cues with identical start/end ordered by id", () => {
    const lines = layoutAll([
      sub("c", 0, 10),
      sub("a", 0, 10),
      sub("b", 0, 10),
    ]);
    assert.equal(lines.get("a"), 0);
    assert.equal(lines.get("b"), 1);
    assert.equal(lines.get("c"), 2);
  });

  it("respects different positive integer line heights", () => {
    const lines = layoutAll([
      sub("a", 0, 10, { lineHeight: 2 }),
      sub("b", 1, 9, { lineHeight: 1 }),
      sub("c", 2, 8, { lineHeight: 3 }),
    ]);
    assert.equal(lines.get("a"), 0); // occupies 0-1
    assert.equal(lines.get("b"), 2); // occupies 2
    assert.equal(lines.get("c"), 3); // occupies 3-5
  });

  it("never assigns a line below the preferred starting line", () => {
    const lines = layoutAll([
      sub("a", 0, 10, { preferredLine: 4 }),
      sub("b", 0, 10),
    ]);
    assert.equal(lines.get("a"), 4);
    assert.equal(lines.get("b"), 0);
  });
});

describe("incremental corrections", () => {
  it("re-lays the whole component bridged by one long subtitle", () => {
    // Groups g1 = {a1,a2} and g2 = {b1,b2} are disjoint in time; the long
    // subtitle L overlaps both and merges them into one component.
    const engine = new SubtitleLayoutEngine([
      sub("a1", 0, 10),
      sub("a2", 0, 10),
      sub("L", 5, 25),
      sub("b1", 20, 30),
      sub("b2", 20, 30),
      sub("far", 100, 110),
    ]);
    assertMatchesFullRecompute(engine, "initial");

    // Shortening L still keeps it overlapping both groups.
    engine.update({ upsert: [sub("L", 6, 24)] });
    assertMatchesFullRecompute(engine, "bridge resized");

    // Raising a2's preferred line ripples through the whole component.
    engine.update({ upsert: [sub("a2", 0, 10, { preferredLine: 3 })] });
    assertMatchesFullRecompute(engine, "preferred line raised");
    assert.equal(engine.currentVersion.lineOf("far"), 0);
  });

  it("handles deletion splitting a component into separate groups", () => {
    const engine = new SubtitleLayoutEngine([
      sub("a", 0, 10),
      sub("L", 5, 25),
      sub("b", 8, 30),
      sub("far", 100, 110, { preferredLine: 2 }),
    ]);
    const before = engine.currentVersion;
    // b conflicts with both a (line 0) and L (line 1), so it lands on 2.
    assert.equal(before.lineOf("a"), 0);
    assert.equal(before.lineOf("L"), 1);
    assert.equal(before.lineOf("b"), 2);

    const after = engine.update({ remove: ["L"] });
    // The component splits; b is re-laid and compacts down to line 1.
    assert.equal(after.lineOf("a"), 0);
    assert.equal(after.lineOf("b"), 1);
    // Untouched far-away cue keeps its line.
    assert.equal(after.lineOf("far"), 2);
    assertMatchesFullRecompute(engine, "after bridge deletion");
  });

  it("re-lays mixed-height components consistently with full recompute", () => {
    const engine = new SubtitleLayoutEngine([
      sub("tall", 0, 10, { lineHeight: 3 }),
      sub("mid", 2, 8, { lineHeight: 2 }),
      sub("flat", 4, 6),
    ]);
    assertMatchesFullRecompute(engine, "mixed heights initial");
    engine.update({ upsert: [sub("mid", 2, 8, { lineHeight: 1 })] });
    assertMatchesFullRecompute(engine, "height shrunk");
    engine.update({ remove: ["tall"] });
    assertMatchesFullRecompute(engine, "tall removed");
  });

  it("ignores no-op corrections but still publishes a version", () => {
    const engine = new SubtitleLayoutEngine([sub("a", 0, 10)]);
    const v0 = engine.currentVersion;
    const v1 = engine.update({
      remove: ["missing"],
      upsert: [sub("a", 0, 10)],
    });
    assert.equal(v1.version, 1);
    assertSameLines(v1.lines, v0.lines, "no-op change keeps lines");
  });
});

describe("immutable layout versions", () => {
  it("keeps historical versions queryable and untouched by later updates", () => {
    const engine = new SubtitleLayoutEngine([sub("a", 0, 10)]);
    const v0 = engine.currentVersion;
    engine.update({ upsert: [sub("b", 0, 10)] });
    engine.update({ remove: ["a"] });

    assert.ok(v0 instanceof LayoutVersion);
    assert.equal(engine.version(0), v0);
    assert.equal(v0.lineOf("a"), 0);
    assert.equal(v0.has("b"), false);
    assert.equal(engine.version(1)!.lineOf("b"), 1);
    assert.equal(engine.version(2)!.has("a"), false);
    assert.equal(engine.version(3), undefined);
    assert.equal(engine.versionCount, 3);
  });
});

describe("randomized differential test against full recompute", () => {
  // Deterministic PRNG (mulberry32) so failures are reproducible.
  function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("matches layoutAll after every random correction batch", () => {
    const random = rng(20261111);
    const pick = (n: number) => Math.floor(random() * n);

    const randomSubtitle = (id: string): Subtitle => {
      const start = pick(60);
      const x0 = pick(6) * 50;
      return sub(id, start, start + 1 + pick(30), {
        x0,
        x1: x0 + 50 + pick(4) * 50,
        lineHeight: 1 + pick(3),
        preferredLine: pick(3),
      });
    };

    const initial: Subtitle[] = [];
    for (let i = 0; i < 8; i += 1) initial.push(randomSubtitle(`s${i}`));
    const engine = new SubtitleLayoutEngine(initial);
    let nextId = initial.length;
    assertMatchesFullRecompute(engine, "initial random set");

    for (let round = 0; round < 300; round += 1) {
      const present = engine.subtitles.map((s) => s.id);
      const remove: string[] = [];
      const upsert: Subtitle[] = [];
      for (const id of present) {
        if (random() < 0.15) remove.push(id);
        else if (random() < 0.2) upsert.push(randomSubtitle(id));
      }
      const additions = pick(4);
      for (let i = 0; i < additions; i += 1) {
        upsert.push(randomSubtitle(`s${nextId}`));
        nextId += 1;
      }
      engine.update({ remove, upsert });
      assertMatchesFullRecompute(engine, `round ${round}`);
    }
  });
});
