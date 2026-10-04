import test from "node:test";
import assert from "node:assert/strict";
import {
  ABSENT, merge, resolve, digest, slotEqual,
  type Conflict, type Doc, type JsonValue, type ResolutionStore, type Slot,
} from "../src/index.js";

test("clean merge: one-sided changes and convergent edits", () => {
  const base = { a: 1, b: 2, c: 3 };
  const left = { a: 10, b: 2, c: 3 };
  const right = { a: 1, b: 20, c: 3 };
  const r = merge(base, left, right);
  assert.deepEqual(r.merged, { a: 10, b: 20, c: 3 });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.diff.map((d) => [d.field, d.op]), [["a", "changed"], ["b", "changed"]]);
});

test("conflict provenance: base/left/right values and digests reported", () => {
  const r = merge({ a: 1 }, { a: 2 }, { a: 3 });
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0]!;
  assert.equal(c.field, "a");
  assert.equal(c.base, 1);
  assert.equal(c.left, 2);
  assert.equal(c.right, 3);
  assert.equal(c.cause, "both-modified");
  assert.equal(c.leftDigest, digest(2));
  assert.equal(c.rightDigest, digest(3));
  assert.deepEqual(r.merged, {}); // unresolved field omitted
});

test("resolution binds both source digests and applies on re-merge", () => {
  const base = { a: 1 };
  const left = { a: 2 };
  const right = { a: 3 };
  const first = merge(base, left, right);
  const entry = resolve(first.conflicts[0]!, 99);
  const store: ResolutionStore = { a: entry };
  const second = merge(base, left, right, store);
  assert.deepEqual(second.merged, { a: 99 });
  assert.deepEqual(second.applied, ["a"]);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(second.carriedStore, store);
});

test("unrelated source changes keep the choice; resolutions are per-field independent", () => {
  const base = { a: 1, b: 1 };
  const left = { a: 2, b: 2 };
  const right = { a: 3, b: 3 };
  const first = merge(base, left, right);
  assert.equal(first.conflicts.length, 2);
  const store: ResolutionStore = {
    a: resolve(first.conflicts.find((c) => c.field === "a")!, 100),
    b: resolve(first.conflicts.find((c) => c.field === "b")!, 200),
  };
  // Sources move on both fields, but only field b's sides actually change.
  const left2 = { a: 2, b: 20 };
  const right2 = { a: 3, b: 3, extra: "new" };
  const second = merge(base, left2, right2, store);
  assert.deepEqual(second.applied, ["a"]); // a's choice still matches its sources
  assert.equal(second.merged.a, 100);
  const reopened = second.conflicts.find((c) => c.field === "b")!;
  assert.equal(reopened.cause, "stale-resolution");
  assert.deepEqual(reopened.stale, store.b);
  assert.equal(second.carriedStore.a, store.a); // a carried, b dropped
  assert.equal(second.carriedStore.b, undefined);
  assert.equal(second.merged.extra, "new");
});

test("stale choice reopens when either side changes; converged sides drop the entry", () => {
  const base = { a: 1 };
  const first = merge(base, { a: 2 }, { a: 3 });
  const store: ResolutionStore = { a: resolve(first.conflicts[0]!, 7) };
  // Right side moves -> digest mismatch -> conflict reopens.
  const moved = merge(base, { a: 2 }, { a: 4 }, store);
  assert.equal(moved.conflicts[0]!.cause, "stale-resolution");
  assert.deepEqual(moved.carriedStore, {});
  // Both sides converge -> no conflict, entry no longer needed.
  const converged = merge(base, { a: 5 }, { a: 5 }, store);
  assert.deepEqual(converged.conflicts, []);
  assert.equal(converged.merged.a, 5);
  assert.deepEqual(converged.carriedStore, {});
});

test("deletions: remove vs edit conflicts, remove vs remove merges", () => {
  const base = { a: 1, b: 2 };
  const r = merge(base, {}, { a: 1, b: 22 }); // left deletes both; right edits b
  assert.equal(r.merged.a, undefined);
  assert.equal(r.conflicts[0]!.field, "b");
  assert.equal(r.conflicts[0]!.left, ABSENT);
  const gone = merge(base, {}, {}); // both delete everything
  assert.deepEqual(gone.merged, {});
  assert.deepEqual(gone.diff.map((d) => d.op), ["removed", "removed"]);
});

test("diff output: added / removed / changed against base", () => {
  const base = { keep: 1, del: 2, chg: 3 };
  const left = { keep: 1, chg: 30, add: 9 };
  const r = merge(base, left, { keep: 1, del: 2, chg: 3 });
  assert.deepEqual(
    r.diff.map((d) => [d.field, d.op, d.from, d.to]),
    [["add", "added", ABSENT, 9], ["chg", "changed", 3, 30], ["del", "removed", 2, ABSENT]],
  );
});

// ---------- randomized branch updates with recompute verification ----------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ["f1", "f2", "f3", "f4", "f5", "f6"];

function randomValue(rand: () => number): JsonValue {
  const pick = rand();
  if (pick < 0.3) return Math.floor(rand() * 10);
  if (pick < 0.55) return "s" + Math.floor(rand() * 5);
  if (pick < 0.7) return rand() < 0.5;
  if (pick < 0.85) return null;
  return { nested: Math.floor(rand() * 3) };
}

function mutate(doc: Doc, rand: () => number): Doc {
  const next: Doc = { ...doc };
  const field = FIELDS[Math.floor(rand() * FIELDS.length)]!;
  if (rand() < 0.3) delete next[field];
  else next[field] = randomValue(rand);
  return next;
}

/** Independent reference merge used to recompute and cross-check the library. */
function referenceMerged(base: Doc, left: Doc, right: Doc, store: ResolutionStore) {
  const merged: Doc = {};
  const conflictFields: string[] = [];
  const appliedFields: string[] = [];
  const fields = new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)]);
  for (const f of fields) {
    const b = f in base ? (base[f] as Slot) : ABSENT;
    const l = f in left ? (left[f] as Slot) : ABSENT;
    const r = f in right ? (right[f] as Slot) : ABSENT;
    const lc = !slotEqual(b, l);
    const rc = !slotEqual(b, r);
    let out: Slot;
    if (!lc && !rc) out = b;
    else if (lc && !rc) out = l;
    else if (rc && !lc) out = r;
    else if (slotEqual(l, r)) out = l;
    else {
      const e = store[f];
      if (e && e.leftDigest === digest(l) && e.rightDigest === digest(r)) {
        out = e.value;
        appliedFields.push(f);
      } else {
        conflictFields.push(f);
        continue;
      }
    }
    if (out !== ABSENT) merged[f] = out as JsonValue;
  }
  return { merged, conflictFields: conflictFields.sort(), appliedFields: appliedFields.sort() };
}

function applyDiff(base: Doc, diff: { field: string; to: Slot }[]): Doc {
  const out: Doc = { ...base };
  for (const d of diff) {
    if (d.to === ABSENT) delete out[d.field];
    else out[d.field] = d.to as JsonValue;
  }
  return out;
}

test("randomized branch updates: recompute cross-check and diff replay", () => {
  const rand = mulberry32(20261005);
  const base: Doc = {};
  for (const f of FIELDS) if (rand() < 0.6) base[f] = randomValue(rand);
  let left: Doc = { ...base };
  let right: Doc = { ...base };
  let store: ResolutionStore = {};
  let staleSeen = 0;
  let appliedSeen = 0;

  for (let round = 0; round < 300; round++) {
    // Random branch updates: both branches evolve incrementally.
    const edits = Math.floor(rand() * 3);
    for (let i = 0; i < edits; i++) left = mutate(left, rand);
    for (let i = 0; i < edits; i++) right = mutate(right, rand);

    const result = merge(base, left, right, store);

    // Determinism: identical recomputation.
    const again = merge(base, left, right, store);
    assert.deepEqual(again, result, `round ${round}: merge not deterministic`);

    // Recompute with the independent reference and cross-check.
    const ref = referenceMerged(base, left, right, store);
    assert.deepEqual(result.merged, ref.merged, `round ${round}: merged mismatch`);
    assert.deepEqual(result.conflicts.map((c) => c.field), ref.conflictFields, `round ${round}: conflicts mismatch`);
    assert.deepEqual([...result.applied].sort(), ref.appliedFields, `round ${round}: applied mismatch`);

    // Diff replay: base + diff == merged.
    assert.deepEqual(applyDiff(base, result.diff), result.merged, `round ${round}: diff replay mismatch`);

    // Every carried entry still matches both current sources.
    for (const [f, e] of Object.entries(result.carriedStore)) {
      assert.equal(e.leftDigest, digest(f in left ? left[f]! : ABSENT));
      assert.equal(e.rightDigest, digest(f in right ? right[f]! : ABSENT));
    }

    // Provenance: conflicts carry accurate side summaries.
    for (const c of result.conflicts) {
      assert.equal(c.leftDigest, digest(c.left));
      assert.equal(c.rightDigest, digest(c.right));
      if (c.cause === "stale-resolution") staleSeen++;
    }
    appliedSeen += result.applied.length;

    // Resolve every open conflict (random choice), then recompute: the
    // recomputed merge must be conflict-free with all choices applied.
    store = { ...result.carriedStore };
    for (const c of result.conflicts) {
      const roll = rand();
      if (roll < 0.4) store[c.field] = resolve(c, c.left);
      else if (roll < 0.7) store[c.field] = resolve(c, c.right);
      else store[c.field] = resolve(c, randomValue(rand));
    }
    if (result.conflicts.length > 0) {
      const recheck = merge(base, left, right, store);
      assert.deepEqual(recheck.conflicts, [], `round ${round}: resolved conflicts still open`);
      for (const c of result.conflicts) {
        assert.ok(recheck.applied.includes(c.field), `round ${round}: ${c.field} not applied`);
      }
      assert.deepEqual(applyDiff(base, recheck.diff), recheck.merged);
      appliedSeen += recheck.applied.length;
      store = recheck.carriedStore;
    }
  }

  assert.ok(staleSeen > 0, "expected stale resolutions to occur during random rounds");
  assert.ok(appliedSeen > 0, "expected resolutions to be reused during random rounds");
});
