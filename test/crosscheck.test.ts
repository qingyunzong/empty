import { test } from "node:test";
import assert from "node:assert";
import { Seg, parsePattern } from "../src/pattern";
import { matchSegments } from "../src/match";
import { findWitness } from "../src/search";

/**
 * Acceptance by exhaustive enumeration on a short finite domain: every path
 * whose segments come from DOMAIN_SEGS and that has at most MAX_DEPTH
 * segments is checked against the direct glob matcher. The symbolic search
 * must agree: its witness is the global minimum, so whenever it fits in the
 * domain the brute-force minimum must equal it exactly.
 */

const DOMAIN_SEGS = ["a", "b", "aa"];
const MAX_DEPTH = 5;

function enumeratePaths(): string[][] {
  const all: string[][] = [[]];
  let frontier: string[][] = [[]];
  for (let d = 0; d < MAX_DEPTH; d++) {
    const next: string[][] = [];
    for (const p of frontier) {
      for (const s of DOMAIN_SEGS) next.push([...p, s]);
    }
    all.push(...next);
    frontier = next;
  }
  return all;
}

const ALL_PATHS = enumeratePaths().sort((p, q) => {
  if (p.length !== q.length) return p.length - q.length;
  const a = p.join("/");
  const b = q.join("/");
  return a < b ? -1 : a > b ? 1 : 0;
});

function bruteForce(a1: Seg[], a2: Seg[], ex: Seg[][]): string[] | null {
  for (const path of ALL_PATHS) {
    if (
      matchSegments(a1, path) &&
      matchSegments(a2, path) &&
      ex.every((e) => !matchSegments(e, path))
    ) {
      return path;
    }
  }
  return null;
}

// Deterministic PRNG (xorshift32) so the test is reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function randomPattern(rand: () => number): Seg[] {
  const len = 1 + Math.floor(rand() * 4); // 1..4 segments
  const segs: Seg[] = [];
  for (let i = 0; i < len; i++) {
    const r = rand();
    if (r < 0.45) segs.push({ kind: "lit", value: rand() < 0.5 ? "a" : "b" });
    else if (r < 0.75) segs.push({ kind: "star" });
    else segs.push({ kind: "starstar" });
  }
  return segs;
}

test("symbolic search matches exhaustive enumeration on the short domain", () => {
  const rand = rng(0xC0FFEE);
  const iterations = 3000;
  let witnesses = 0;
  let empties = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const a1 = randomPattern(rand);
    const a2 = randomPattern(rand);
    const exCount = Math.floor(rand() * 3); // 0..2 excludes
    const ex: Seg[][] = [];
    for (let i = 0; i < exCount; i++) ex.push(randomPattern(rand));

    const res = findWitness(a1, a2, ex, { budget: 1_000_000, maxDepth: 64 });
    const brute = bruteForce(a1, a2, ex);

    if (res.status === "witness") {
      witnesses++;
      if (res.path.length <= MAX_DEPTH) {
        assert.deepStrictEqual(
          brute,
          res.path,
          `case #${iter}: ${JSON.stringify({ a1, a2, ex })}`
        );
      } else {
        // Global minimum is longer than the domain depth: brute force,
        // capped at MAX_DEPTH, must find nothing.
        assert.strictEqual(brute, null, `case #${iter}`);
      }
    } else if (res.status === "empty") {
      empties++;
      assert.strictEqual(brute, null, `case #${iter}: expected empty`);
    } else {
      assert.fail(`unexpected unknown in case #${iter}: ${res.reason}`);
    }
  }
  assert.ok(witnesses > iterations / 3, `too few witness cases: ${witnesses}`);
  assert.ok(empties > 0, "expected some empty cases");
  console.log(`  crosscheck: ${iterations} cases, ${witnesses} witnesses, ${empties} empty`);
});

test("hand-picked cases against brute force", () => {
  const cases: Array<[string, string, string[]]> = [
    ["a/*", "*/b", []],
    ["**", "**", ["a", "a/*"]],
    ["a/**/b", "**/b", []],
    ["*/b", "b/*", []],
    ["**", "a/**/a", ["a/a", "a/b/a"]],
  ];
  for (const [s1, s2, sex] of cases) {
    const a1 = parsePattern(s1);
    const a2 = parsePattern(s2);
    const ex = sex.map(parsePattern);
    const res = findWitness(a1, a2, ex);
    const brute = bruteForce(a1, a2, ex);
    if (res.status === "witness") {
      assert.deepStrictEqual(brute, res.path, `${s1} & ${s2} ex=${sex}`);
    } else {
      assert.strictEqual(res.status, "empty");
      assert.strictEqual(brute, null, `${s1} & ${s2} ex=${sex}`);
    }
  }
});
