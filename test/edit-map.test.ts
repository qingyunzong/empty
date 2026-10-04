import { test } from "node:test";
import {
  ok,
  equal,
  deepEqual,
  throws,
} from "node:assert/strict";
import {
  applyEdits,
  EditOverlapError,
  type Affinity,
  type Edit,
  type EditSession,
} from "../src/edit-map.js";

const ed = (start: number, end: number, text: string): Edit => ({
  start,
  end,
  text,
});

// ---------------------------------------------------------------------------
// Fixed-behavior unit tests
// ---------------------------------------------------------------------------

test("applies replace, delete and insert on the same original", () => {
   const s = applyEdits("hello world", [
     ed(0, 5, "goodbye"), // replace
     ed(5, 11, ""), // delete
     ed(5, 5, " cruel"), // insert at the boundary, request order kept
   ]);
  equal(s.text, "goodbye cruel");
});

test("rejects overlapping non-empty intervals", () => {
  throws(() => applyEdits("abcdef", [ed(0, 3, "x"), ed(2, 4, "y")]), EditOverlapError);
  throws(() => applyEdits("abcdef", [ed(1, 4, "x"), ed(1, 4, "y")]), EditOverlapError);
  throws(() => applyEdits("abcdef", [ed(0, 6, "x"), ed(2, 3, "y")]), EditOverlapError);
});

test("rejects insertion strictly inside a replaced interval", () => {
  throws(() => applyEdits("abcdef", [ed(1, 5, "x"), ed(3, 3, "y")]), EditOverlapError);
  // ... regardless of request order
  throws(() => applyEdits("abcdef", [ed(3, 3, "y"), ed(1, 5, "x")]), EditOverlapError);
});

test("allows touching intervals and boundary insertions", () => {
  const s = applyEdits("aabbcc", [ed(0, 2, "A"), ed(2, 4, "B"), ed(4, 6, "C")]);
  equal(s.text, "ABC");
   // insertion exactly at the start and end boundary of a replacement;
   // same-start edits are emitted in request order (X before L here)
   const t = applyEdits("abcd", [ed(1, 3, "X"), ed(1, 1, "L"), ed(3, 3, "R")]);
   equal(t.text, "aXLRd");
  // boundary insertion requested before the replacement still applies
  const u = applyEdits("abcd", [ed(1, 1, "L"), ed(1, 3, "X")]);
  equal(u.text, "aLXd");
});

test("same-point insertions keep request order", () => {
  const s = applyEdits("ab", [ed(1, 1, "1"), ed(1, 1, "2"), ed(1, 1, "3")]);
  equal(s.text, "a123b");
  // interleaved with other edits, request order among same point is stable
  const t = applyEdits("ab", [
    ed(1, 1, "second"),
    ed(0, 0, "start:"),
    ed(1, 1, "first"),
  ]);
  equal(t.text, "start:asecondfirstb");
});

test("rejects out-of-range and malformed edits", () => {
  throws(() => applyEdits("abc", [ed(-1, 2, "x")]), RangeError);
  throws(() => applyEdits("abc", [ed(0, 4, "x")]), RangeError);
  throws(() => applyEdits("abc", [ed(2, 1, "x")]), RangeError);
  throws(() => applyEdits("abc", [ed(0.5, 1, "x")]), RangeError);
});

test("maps positions inside a replaced interval to edges by affinity", () => {
  const s = applyEdits("abcd", [ed(1, 3, "XY")]); // "aXYd"
  equal(s.toNew(2, "left"), 1);
  equal(s.toNew(2, "right"), 3);
  equal(s.toOld(2, "left"), 1);
  equal(s.toOld(2, "right"), 3);
  // boundaries map to boundaries
  equal(s.toNew(1), 1);
  equal(s.toNew(3), 3);
  equal(s.toOld(1), 1);
  equal(s.toOld(3), 3);
});

test("maps positions inside a pure deletion to the collapse point", () => {
  const s = applyEdits("abcd", [ed(1, 3, "")]); // "ad"
  equal(s.toNew(2, "left"), 1);
  equal(s.toNew(2, "right"), 1);
  // the collapse point itself binds to either original edge by affinity
  equal(s.toOld(1, "left"), 1);
  equal(s.toOld(1, "right"), 3);
});

test("insertion point affinity: left stays before, right moves after", () => {
  const s = applyEdits("ab", [ed(1, 1, "XY")]); // "aXYb"
  equal(s.toNew(1, "left"), 1);
  equal(s.toNew(1, "right"), 3);
  // inserted text has no original counterpart; binds to the insertion point
  equal(s.toOld(2, "left"), 1);
  equal(s.toOld(2, "right"), 1);
});

test("composition round-trips and collapses as documented", () => {
  const s = applyEdits("hello world", [ed(0, 5, "goodbye"), ed(6, 11, "")]);
  for (const affinity of ["left", "right"] as const) {
    equal(s.toOld(s.toNew(5, affinity), affinity), 5);
  }
  // the deletion [6, 11) collapses to one point; each affinity keeps the
  // matching edge and pulls the opposite boundary onto it
  equal(s.toOld(s.toNew(6, "left"), "left"), 6);
  equal(s.toOld(s.toNew(11, "right"), "right"), 11);
  equal(s.toOld(s.toNew(11, "left"), "left"), 6);
  equal(s.toOld(s.toNew(6, "right"), "right"), 11);
});

// ---------------------------------------------------------------------------
// Exhaustive enumeration of short texts and edits
// ---------------------------------------------------------------------------

interface Placed extends Edit {
  newStart: number;
  newEnd: number;
}

/** Independent application: group by start, splice groups right to left. */
function bruteForceApply(original: string, edits: Edit[]): string {
  const indexed = edits.map((e, i) => ({ ...e, index: i }));
  indexed.sort((a, b) => a.start - b.start || a.index - b.index);
  const groups: { start: number; end: number; text: string }[] = [];
  for (const e of indexed) {
    const last = groups[groups.length - 1];
    if (last && last.start === e.start) {
      last.text += e.text;
      last.end = Math.max(last.end, e.end);
    } else {
      groups.push({ start: e.start, end: e.end, text: e.text });
    }
  }
  let text = original;
  for (let k = groups.length - 1; k >= 0; k--) {
    const g = groups[k]!;
    text = text.slice(0, g.start) + g.text + text.slice(g.end);
  }
  return text;
}

/** Independent placement of edits in the new text. */
function place(original: string, edits: Edit[]): Placed[] {
  const indexed = edits.map((e, i) => ({ ...e, index: i }));
  indexed.sort((a, b) => a.start - b.start || a.index - b.index);
  const placed: Placed[] = [];
  let cursor = 0;
  let newLen = 0;
  for (const e of indexed) {
    newLen += Math.max(0, e.start - cursor);
    const newStart = newLen;
    newLen += e.text.length;
    placed.push({ ...e, newStart, newEnd: newLen });
    cursor = Math.max(cursor, e.end);
  }
  return placed;
}

function conflicts(a: Edit, b: Edit): boolean {
  const aEmpty = a.start === a.end;
  const bEmpty = b.start === b.end;
  if (aEmpty && bEmpty) return false;
  if (aEmpty) return b.start < a.start && a.start < b.end;
  if (bEmpty) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function hasConflict(edits: Edit[]): boolean {
  for (let i = 0; i < edits.length; i++) {
    for (let j = i + 1; j < edits.length; j++) {
      if (conflicts(edits[i]!, edits[j]!)) return true;
    }
  }
  return false;
}

const AFFINITIES: Affinity[] = ["left", "right"];

function verifyMappings(session: EditSession, edits: Edit[]): void {
  const { original, text } = session;
  const placed = place(original, edits);

  for (const affinity of AFFINITIES) {
    const pick = affinity === "left" ? Math.min : Math.max;
    const toNewMap: number[] = [];
    const toOldMap: number[] = [];
    for (let p = 0; p <= original.length; p++) {
      toNewMap.push(session.toNew(p, affinity));
    }
    for (let q = 0; q <= text.length; q++) {
      toOldMap.push(session.toOld(q, affinity));
    }
    // Range and monotonicity. toNew is always non-decreasing; toOld can
    // locally decrease when an insertion shares its point with a
    // replacement (edge binding then points across the inserted text), so
    // no monotonicity is asserted for it.
    for (let p = 0; p <= original.length; p++) {
      const q = toNewMap[p]!;
      ok(q >= 0 && q <= text.length, "toNew in range");
      if (p > 0) ok(q >= toNewMap[p - 1]!, "toNew is non-decreasing");
    }
    for (let q = 0; q <= text.length; q++) {
      const p = toOldMap[q]!;
      ok(p >= 0 && p <= original.length, "toOld in range");
    }
    // Fiber rule: toOld(q) is the extreme (min for left, max for right)
    // original position mapping to q; hence every reachable q round-trips.
    const fibers = new Map<number, number[]>();
    toNewMap.forEach((q, p) => {
      const list = fibers.get(q);
      if (list) list.push(p);
      else fibers.set(q, [p]);
    });
    for (const [q, preimages] of fibers) {
      equal(toOldMap[q], pick(...preimages), `toOld(${q}, ${affinity})`);
      equal(
        toNewMap[toOldMap[q]!],
        q,
        `toNew(toOld(${q}, ${affinity})) round-trips`,
      );
    }
    // Edge binding strictly inside replaced intervals and their outputs
    // (a real preimage, when one exists, takes precedence over binding).
    // The edge is the image of the interval's boundary position, which
    // already accounts for insertions sharing that endpoint.
    for (const e of placed) {
      const edge =
        affinity === "left" ? toNewMap[e.start]! : toNewMap[e.end]!;
      for (let p = e.start + 1; p < e.end; p++) {
        equal(toNewMap[p], edge, `toNew(${p}, ${affinity}) binds to edge`);
      }
      const oldEdge = affinity === "left" ? e.start : e.end;
      for (let q = e.newStart + 1; q < e.newEnd; q++) {
        if (fibers.has(q)) continue;
        equal(toOldMap[q], oldEdge, `toOld(${q}, ${affinity}) binds to edge`);
      }
    }
  }
}

function* shortOriginals(): Generator<string> {
  yield "";
  for (let len = 1; len <= 4; len++) {
    for (let mask = 0; mask < 1 << len; mask++) {
      let s = "";
      for (let i = 0; i < len; i++) s += (mask >> i) & 1 ? "b" : "a";
      yield s;
    }
  }
}

const REPLACEMENT_TEXTS = ["", "x", "yz"];

function allEdits(len: number): Edit[] {
  const out: Edit[] = [];
  for (let start = 0; start <= len; start++) {
    for (let end = start; end <= len; end++) {
      for (const text of REPLACEMENT_TEXTS) out.push(ed(start, end, text));
    }
  }
  return out;
}

function checkCase(original: string, edits: Edit[]): void {
  if (hasConflict(edits)) {
    throws(() => applyEdits(original, edits), EditOverlapError);
    return;
  }
  const session = applyEdits(original, edits);
  equal(
    session.text,
    bruteForceApply(original, edits),
    `text for ${JSON.stringify({ original, edits })}`,
  );
  verifyMappings(session, edits);
}

test("exhaustive: every single edit on every short original", () => {
  let cases = 0;
  for (const original of shortOriginals()) {
    for (const e of allEdits(original.length)) {
      checkCase(original, [e]);
      cases++;
    }
  }
  ok(cases > 500, `enumerated ${cases} single-edit cases`);
});

test("exhaustive: every ordered edit pair on every short original", () => {
  let cases = 0;
  let rejected = 0;
  for (const original of shortOriginals()) {
    const edits = allEdits(original.length);
    for (const a of edits) {
      for (const b of edits) {
        if (hasConflict([a, b])) rejected++;
        checkCase(original, [a, b]);
        cases++;
      }
    }
  }
  ok(cases > 30000, `enumerated ${cases} pair cases`);
  ok(rejected > 0, `of which ${rejected} were rejected as overlapping`);
});

test("exhaustive: same-point insertion bundles keep request order", () => {
  const texts = ["", "x", "yz"];
  for (const original of shortOriginals()) {
    for (let p = 0; p <= original.length; p++) {
      for (const a of texts) {
        for (const b of texts) {
          for (const c of texts) {
            const session = applyEdits(original, [
              ed(p, p, a),
              ed(p, p, b),
              ed(p, p, c),
            ]);
            equal(
              session.text,
              original.slice(0, p) + a + b + c + original.slice(p),
            );
          }
        }
      }
    }
  }
});

test("mapping composition is consistent with substring invariants", () => {
  // For gap positions, the text before the mapped position is exactly the
  // edited prefix of the original.
  for (const original of shortOriginals()) {
    const edits = allEdits(original.length);
    for (const e of edits) {
      if (hasConflict([e])) continue;
      const session = applyEdits(original, [e]);
      for (let p = 0; p <= original.length; p++) {
        const inside = e.start < p && p < e.end;
        if (inside) continue;
         const q = session.toNew(p, "left");
         const prefixEdits =
           e.start < p ? [ed(e.start, Math.min(e.end, p), e.text)] : [];
        equal(
          session.text.slice(0, q),
          applyEdits(original.slice(0, p), prefixEdits).text,
        );
      }
    }
  }
});
