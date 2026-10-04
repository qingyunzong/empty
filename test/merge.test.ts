import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEdits,
  merge,
  normalizeEdits,
  type Edit,
} from "../src/merge.js";

// ---------- unit tests: specified merge behaviors ----------

test("non-overlapping edits from both sides merge cleanly", () => {
  const r = merge("hello world", [{ start: 0, end: 5, text: "hi" }], [
    { start: 6, end: 11, text: "there" },
  ]);
  assert.ok(r.ok);
  assert.equal(r.text, "hi there");
  assert.deepEqual(r.edits, [
    { start: 0, end: 5, text: "hi" },
    { start: 6, end: 11, text: "there" },
  ]);
});

test("insertions at the same point are ordered by branch id", () => {
  const r1 = merge("ab", [{ start: 1, end: 1, text: "X" }], [
    { start: 1, end: 1, text: "Y" },
  ], "alice", "bob");
  assert.ok(r1.ok);
  assert.equal(r1.text, "aXYb");

  const r2 = merge("ab", [{ start: 1, end: 1, text: "X" }], [
    { start: 1, end: 1, text: "Y" },
  ], "zeta", "alpha");
  assert.ok(r2.ok);
  assert.equal(r2.text, "aYXb");
});

test("identical edits on both sides are applied once", () => {
  const r = merge("abcd", [{ start: 1, end: 3, text: "Z" }], [
    { start: 1, end: 3, text: "Z" },
  ]);
  assert.ok(r.ok);
  assert.equal(r.text, "aZd");
  assert.equal(r.edits.length, 1);
});

test("overlapping edits with different content conflict", () => {
  const r = merge("abcd", [{ start: 1, end: 3, text: "x" }], [
    { start: 2, end: 4, text: "y" },
  ]);
  assert.ok(!r.ok);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], {
    a: { start: 1, end: 3, text: "x" },
    b: { start: 2, end: 4, text: "y" },
  });
});

test("same range with different replacement text conflicts", () => {
  const r = merge("abcd", [{ start: 1, end: 3, text: "x" }], [
    { start: 1, end: 3, text: "y" },
  ]);
  assert.ok(!r.ok);
});

test("deletion conflicts with a modification strictly inside it", () => {
  const r = merge("abcdef", [{ start: 1, end: 5, text: "" }], [
    { start: 2, end: 4, text: "Z" },
  ]);
  assert.ok(!r.ok);
  assert.equal(r.conflicts.length, 1);
});

test("insertion strictly inside the other side's range conflicts", () => {
  const r = merge("abcdef", [{ start: 3, end: 3, text: "Z" }], [
    { start: 1, end: 5, text: "Q" },
  ]);
  assert.ok(!r.ok);
});

test("insertion at the boundary of the other side's edit merges", () => {
  const atStart = merge("abcdef", [{ start: 1, end: 1, text: "Z" }], [
    { start: 1, end: 5, text: "Q" },
  ]);
  assert.ok(atStart.ok);
  assert.equal(atStart.text, "aZQf");

  const atEnd = merge("abcdef", [{ start: 5, end: 5, text: "Z" }], [
    { start: 1, end: 5, text: "Q" },
  ]);
  assert.ok(atEnd.ok);
  assert.equal(atEnd.text, "aQZf");
});

test("non-conflicting edits around a conflict still merge; conflicts reported", () => {
  const r = merge("abcdef", [
    { start: 0, end: 1, text: "A" },
    { start: 2, end: 4, text: "x" },
  ], [
    { start: 3, end: 5, text: "y" },
    { start: 5, end: 6, text: "F" },
  ]);
  assert.ok(!r.ok);
  assert.equal(r.conflicts.length, 1);
});

test("position mapping around a replacement", () => {
  const r = merge("abcdef", [{ start: 2, end: 4, text: "XYZ" }], []);
  assert.ok(r.ok);
  assert.equal(r.text, "abXYZef");
  assert.equal(r.map.mergedLength, 7);
  assert.equal(r.map.toMerged(0), 0);
  assert.equal(r.map.toMerged(2), 2);
  assert.equal(r.map.toMerged(3), null);
  assert.equal(r.map.toMerged(4), 5);
  assert.equal(r.map.toMerged(6), 7);
  assert.equal(r.map.toOriginal(0), 0);
  assert.equal(r.map.toOriginal(2), 2);
  assert.equal(r.map.toOriginal(3), null);
  assert.equal(r.map.toOriginal(4), null);
  assert.equal(r.map.toOriginal(5), 4);
  assert.equal(r.map.toOriginal(7), 6);
});

test("position mapping for deletion and insertion", () => {
  const r = merge("abcdef", [{ start: 1, end: 4, text: "" }], [
    { start: 5, end: 5, text: "ZZ" },
  ]);
  assert.ok(r.ok);
  assert.equal(r.text, "aeZZf");
  assert.equal(r.map.toMerged(1), 1);
  assert.equal(r.map.toMerged(2), null);
  assert.equal(r.map.toMerged(4), 1);
  assert.equal(r.map.toMerged(5), 2);
  assert.equal(r.map.toMerged(6), 5);
  assert.equal(r.map.toOriginal(0), 0);
  assert.equal(r.map.toOriginal(1), 1);
  assert.equal(r.map.toOriginal(2), 5);
  assert.equal(r.map.toOriginal(3), null);
  assert.equal(r.map.toOriginal(4), 5);
  assert.equal(r.map.toOriginal(5), 6);
});

test("normalizeEdits combines overlapping edits within one side", () => {
  const n = normalizeEdits("abcdef", [
    { start: 1, end: 4, text: "XY" },
    { start: 3, end: 5, text: "Z" },
  ]);
  assert.deepEqual(n, [{ start: 1, end: 5, text: "XYZ" }]);
  assert.equal(applyEdits("abcdef", n), "aXYZf");
});

test("out-of-bounds edits are rejected", () => {
  assert.throws(() => merge("ab", [{ start: 0, end: 3, text: "x" }], []));
  assert.throws(() => merge("ab", [], [{ start: -1, end: 1, text: "x" }]));
});

// ---------- exhaustive enumeration over short strings ----------

const TEXTS = ["", "x", "y", "xy"];

function* allStrings(alphabet: string[], maxLen: number): Generator<string> {
  yield "";
  if (maxLen === 0) return;
  for (const rest of allStrings(alphabet, maxLen - 1)) {
    for (const ch of alphabet) yield ch + rest;
  }
}

function allEdits(base: string): Edit[] {
  const edits: Edit[] = [];
  for (let s = 0; s <= base.length; s++) {
    for (let e = s; e <= base.length; e++) {
      for (const text of TEXTS) edits.push({ start: s, end: e, text });
    }
  }
  return edits;
}

function splice(s: string, start: number, end: number, text: string): string {
  return s.slice(0, start) + text + s.slice(end);
}

/**
 * Independent oracle: applies one edit, then splices the other into the
 * result at shifted offsets. Returns null when the two edits overlap
 * (conflict) and the expected merged text otherwise.
 */
function oracle(
  base: string,
  ea: Edit,
  eb: Edit,
  branchA: string,
  branchB: string,
): string | null {
  if (ea.start === eb.start && ea.end === eb.end && ea.text === eb.text) {
    return splice(base, ea.start, ea.end, ea.text);
  }
  if (ea.start === ea.end && eb.start === eb.end && ea.start === eb.start) {
    const t = branchA <= branchB ? ea.text + eb.text : eb.text + ea.text;
    return splice(base, ea.start, ea.start, t);
  }
  if (eb.end <= ea.start) {
    const deltaB = eb.text.length - (eb.end - eb.start);
    const s1 = splice(base, eb.start, eb.end, eb.text);
    return splice(s1, ea.start + deltaB, ea.end + deltaB, ea.text);
  }
  if (ea.end <= eb.start) {
    const deltaA = ea.text.length - (ea.end - ea.start);
    const s1 = splice(base, ea.start, ea.end, ea.text);
    return splice(s1, eb.start + deltaA, eb.end + deltaA, eb.text);
  }
  return null;
}

function pairConflicts(a: Edit, b: Edit): boolean {
  if (a.start === b.start && a.end === b.end && a.text === b.text) return false;
  return !(a.end <= b.start || b.end <= a.start);
}

function fmt(e: Edit): string {
  return `[${e.start},${e.end})->${JSON.stringify(e.text)}`;
}

/** Is [from, to) fully covered by a run of adjacent empty-text edits? */
function collapsedRun(edits: Edit[], from: number, to: number): boolean {
  let covered = from;
  for (const e of edits) {
    if (e.text !== "") continue;
    if (e.start <= covered && e.end > covered) covered = e.end;
  }
  return covered >= to;
}

/** Structural invariants every successful merge must satisfy. */
function checkInvariants(
  base: string,
  editsA: Edit[],
  editsB: Edit[],
  branchA: string,
  branchB: string,
): void {
  const ctx = `base=${JSON.stringify(base)} A=[${editsA.map(fmt)}] B=[${editsB.map(fmt)}]`;
  const r1 = merge(base, editsA, editsB, branchA, branchB);
  const r2 = merge(base, editsB, editsA, branchB, branchA);
  assert.equal(r1.ok, r2.ok, `symmetric ok: ${ctx}`);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.text, r2.text, `symmetric text: ${ctx}`);

  const { edits, text, map } = r1;
  assert.equal(text, applyEdits(base, edits), `apply consistency: ${ctx}`);
  assert.equal(map.mergedLength, text.length, `mergedLength: ${ctx}`);
  assert.equal(
    text.length,
    base.length + edits.reduce((d, e) => d + e.text.length - (e.end - e.start), 0),
    `length delta: ${ctx}`,
  );

  // edits land in order, gaps and replacements in place (PositionMap-independent)
  {
    let out = 0;
    let pos = 0;
    for (const e of edits) {
      const gap = e.start - pos;
      assert.equal(text.slice(out, out + gap), base.slice(pos, e.start), `gap content: ${ctx} ${fmt(e)}`);
      out += gap;
      assert.equal(text.slice(out, out + e.text.length), e.text, `edit in place: ${ctx} ${fmt(e)}`);
      out += e.text.length;
      pos = e.end;
    }
    assert.equal(text.slice(out), base.slice(pos), `trailing gap: ${ctx}`);
  }

  // mappings are monotonic non-decreasing on their non-null domain
  {
    let prev = 0;
    for (let o = 0; o <= base.length; o++) {
      const m = map.toMerged(o);
      if (m === null) continue;
      assert.ok(m >= prev, `toMerged monotonic at o=${o}: ${ctx}`);
      prev = m;
    }
    prev = 0;
    for (let m = 0; m <= map.mergedLength; m++) {
      const o = map.toOriginal(m);
      if (o === null) continue;
      assert.ok(o >= prev, `toOriginal monotonic at m=${m}: ${ctx}`);
      prev = o;
    }
  }

  // offset round-trips. Two inherent ambiguities are allowed:
  //  - both endpoints of a deleted range collapse to one merged point, whose
  //    inverse is the range start;
  //  - one base offset before inserted text corresponds to two merged
  //    offsets (around the insertion); the insertion end maps back to it.
  for (let o = 0; o <= base.length; o++) {
    const m = map.toMerged(o);
    if (m === null) continue;
    const back = map.toOriginal(m);
    if (back === o) continue;
    const collapsed = back !== null && back < o && collapsedRun(edits, back, o);
    assert.ok(collapsed, `roundtrip o=${o} m=${m} back=${back}: ${ctx}`);
  }
  for (let m = 0; m <= map.mergedLength; m++) {
    const o = map.toOriginal(m);
    if (o === null) continue;
    const forward = map.toMerged(o);
    if (forward === m) continue;
    const prefixes = new Set<number>();
    let acc = 0;
    for (const e of edits) {
      if (e.start === e.end && e.end === o) {
        acc += e.text.length;
        prefixes.add(acc);
      }
    }
    const insertion = forward !== null && prefixes.has(m - forward);
    assert.ok(insertion, `roundtrip m=${m} o=${o} forward=${forward}: ${ctx}`);
  }

  // every base interval untouched by edits keeps its content in the output;
  // an insertion exactly at the interval start counts as touching it, because
  // the start offset maps before the inserted text
  for (let s = 0; s <= base.length; s++) {
    for (let e = s; e <= base.length; e++) {
      const clean = edits.every(
        (x) => (x.end <= s && !(x.start === x.end && x.start === s)) || x.start >= e,
      );
      if (!clean) continue;
      const ms = map.toMerged(s);
      const me = map.toMerged(e);
      assert.ok(ms !== null && me !== null, `untouched mapped: ${ctx} [${s},${e})`);
      assert.equal(text.slice(ms, me), base.slice(s, e), `untouched content: ${ctx} [${s},${e})`);
    }
  }

  // every output interval outside replacements comes from identical base
  // content; an interval starting at a collapsed deletion point is excluded,
  // because that point's inverse is the deletion start, not its end
  const spans = edits.map((x) => {
    let delta = 0;
    for (const y of edits) {
      if (y === x) break;
      delta += y.text.length - (y.end - y.start);
    }
    return { os: x.start + delta, oe: x.start + delta + x.text.length, x };
  });
  for (let s = 0; s <= map.mergedLength; s++) {
    for (let e = s; e <= map.mergedLength; e++) {
      const clean = spans.every(
        (sp) =>
          (sp.oe <= s && !(sp.x.text === "" && sp.x.start < sp.x.end && sp.os === s)) ||
          sp.os >= e,
      );
      if (!clean) continue;
      const os = map.toOriginal(s);
      const oe = map.toOriginal(e);
      assert.ok(os !== null && oe !== null, `output interval mapped: ${ctx} [${s},${e})`);
      assert.equal(base.slice(os, oe), text.slice(s, e), `output interval content: ${ctx} [${s},${e})`);
    }
  }
}

test("exhaustive: every pair of single edits on all short strings", () => {
  let merges = 0;
  let conflicts = 0;
  for (const base of allStrings(["a", "b"], 4)) {
    const edits = allEdits(base);
    for (const ea of edits) {
      for (const eb of edits) {
        const expected = oracle(base, ea, eb, "a", "b");
        const r = merge(base, [ea], [eb], "a", "b");
        const ctx = `base=${JSON.stringify(base)} ea=${fmt(ea)} eb=${fmt(eb)}`;
        assert.equal(r.ok, expected !== null, `ok matches oracle: ${ctx}`);
        if (expected === null) {
          conflicts++;
          continue;
        }
        assert.ok(r.ok);
        assert.equal(r.text, expected, `text matches oracle: ${ctx}`);
        checkInvariants(base, [ea], [eb], "a", "b");
        merges++;
      }
    }
  }
  assert.ok(merges > 0 && conflicts > 0);
  console.log(`single-edit pairs: ${merges + conflicts} total, ${merges} merged, ${conflicts} conflicts`);
});

test("exhaustive: every pair of two-edit sets on very short strings", () => {
  let merges = 0;
  let conflicts = 0;
  for (const base of allStrings(["a", "b"], 2)) {
    const edits = allEdits(base);
    const seen = new Set<string>();
    const sets: Edit[][] = [];
    for (let x = 0; x < edits.length; x++) {
      for (let y = x + 1; y < edits.length; y++) {
        const pair = normalizeEdits(base, [edits[x]!, edits[y]!]);
        const key = JSON.stringify(pair);
        if (!seen.has(key)) {
          seen.add(key);
          sets.push(pair);
        }
      }
    }
    for (const sa of sets) {
      for (const sb of sets) {
        const expectConflict = sa.some((ea) => sb.some((eb) => pairConflicts(ea, eb)));
        const r = merge(base, sa, sb, "a", "b");
        const ctx = `base=${JSON.stringify(base)} A=[${sa.map(fmt)}] B=[${sb.map(fmt)}]`;
        assert.equal(r.ok, !expectConflict, `ok matches predicate: ${ctx}`);
        if (expectConflict) {
          conflicts++;
          continue;
        }
        checkInvariants(base, sa, sb, "a", "b");
        merges++;
      }
    }
  }
  assert.ok(merges > 0 && conflicts > 0);
  console.log(`two-edit set pairs: ${merges + conflicts} total, ${merges} merged, ${conflicts} conflicts`);
});
