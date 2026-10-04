/**
 * Half-open interval edits applied to a shared original text, producing the
 * edited text plus a bidirectional position mapping between the two.
 *
 * Semantics
 * ---------
 * - Every edit replaces the half-open interval [start, end) of the *original*
 *   text with `text`. An edit with start === end is a pure insertion.
 * - All edits refer to the same original coordinate space.
 * - Overlapping edits are rejected with {@link EditOverlapError}. Two
 *   non-empty edits overlap iff `a.start < b.end && b.start < a.end`, and an
 *   insertion conflicts iff its point lies strictly inside a non-empty edit.
 *   Touching intervals (a.end === b.start) and insertions at an interval
 *   boundary are allowed; rejection does not depend on request order.
 * - Insertions at the same point are emitted in request order (stable sort).
 * - Position mapping uses an affinity for positions that have no exact
 *   counterpart:
 *     - toNew: a position strictly inside a replaced interval binds to the
 *       start ("left") or end ("right") of that edit's output.
 *     - toOld: a position strictly inside an edit's output binds to the
 *       start ("left") or end ("right") of the edit's original interval.
 *   Boundary positions map to the corresponding boundary; at an insertion
 *   point a "left" marker stays before the inserted text while a "right"
 *   marker moves after it.
 * - Composition: toNew(toOld(q, a), a) === q for every new-text position q
 *   that is not strictly inside an edit's output. In the other direction the
 *   mapping can be many-to-one (a deletion collapses its whole interval to
 *   one point), so toOld(q, "left") / toOld(q, "right") return the smallest
 *   / largest original position mapping to q.
 */

export type Affinity = "left" | "right";

export interface Edit {
  /** Inclusive start offset in the original text. */
  readonly start: number;
  /** Exclusive end offset in the original text. */
  readonly end: number;
  /** Replacement text (empty string deletes the interval). */
  readonly text: string;
}

export class EditOverlapError extends Error {
  readonly a: Edit;
  readonly b: Edit;
  constructor(a: Edit, b: Edit) {
    super(
      `edits overlap: [${a.start}, ${a.end}) vs [${b.start}, ${b.end})`,
    );
    this.name = "EditOverlapError";
    this.a = a;
    this.b = b;
  }
}

interface PlacedEdit extends Edit {
  /** Inclusive start of this edit's output in the new text. */
  readonly newStart: number;
  /** Exclusive end of this edit's output in the new text. */
  readonly newEnd: number;
}

export interface EditSession {
  /** The original text the edits were based on. */
  readonly original: string;
  /** The resulting edited text. */
  readonly text: string;
  /** Map an original-text position to the new text. */
  toNew(pos: number, affinity?: Affinity): number;
  /** Map a new-text position back to the original text. */
  toOld(pos: number, affinity?: Affinity): number;
}

function checkPosition(pos: number, max: number, what: string): void {
  if (!Number.isInteger(pos) || pos < 0 || pos > max) {
    throw new RangeError(`${what} position ${pos} out of range [0, ${max}]`);
  }
}

export function applyEdits(
  original: string,
  edits: readonly Edit[],
): EditSession {
  const len = original.length;
  const indexed = edits.map((e, i) => ({ ...e, index: i }));
  for (const e of indexed) {
    if (
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < 0 ||
      e.start > e.end ||
      e.end > len
    ) {
      throw new RangeError(
        `invalid edit [${e.start}, ${e.end}) for text of length ${len}`,
      );
    }
  }
  // Sort by start; ties (same-point insertions) keep request order.
  indexed.sort((a, b) => a.start - b.start || a.index - b.index);

  // Non-empty edits: adjacent check in sorted order suffices.
  const nonEmpty = indexed.filter((e) => e.start < e.end);
  for (let k = 1; k < nonEmpty.length; k++) {
    const prev = nonEmpty[k - 1]!;
    const cur = nonEmpty[k]!;
    if (cur.start < prev.end) {
      throw new EditOverlapError(prev, cur);
    }
  }
  // Insertions conflict only when strictly inside a non-empty edit.
  for (const e of indexed) {
    if (e.start !== e.end) continue;
    for (const ne of nonEmpty) {
      if (ne.start < e.start && e.start < ne.end) {
        throw new EditOverlapError(ne, e);
      }
    }
  }

  const placed: PlacedEdit[] = [];
  let text = "";
  let cursor = 0;
  for (const e of indexed) {
    text += original.slice(cursor, e.start);
    const newStart = text.length;
    text += e.text;
    placed.push({
      start: e.start,
      end: e.end,
      text: e.text,
      newStart,
      newEnd: text.length,
    });
    // An insertion sharing its start with a preceding edit must not rewind.
    cursor = Math.max(cursor, e.end);
  }
  text += original.slice(cursor);

  // Maximal runs of same-point insertions occupy a contiguous output range
  // that collapses to the insertion point in the original text.
  const insertionRuns: { newStart: number; newEnd: number; point: number }[] =
    [];
  for (let i = 0; i < placed.length; i++) {
    const e = placed[i]!;
    if (e.start !== e.end) continue;
    let j = i;
    while (
      j + 1 < placed.length &&
      placed[j + 1]!.start === e.start &&
      placed[j + 1]!.end === e.start
    ) {
      j++;
    }
    insertionRuns.push({
      newStart: e.newStart,
      newEnd: placed[j]!.newEnd,
      point: e.start,
    });
    i = j;
  }

  function toNew(pos: number, affinity: Affinity = "left"): number {
    checkPosition(pos, len, "original");
    let delta = 0;
    for (const e of placed) {
      if (e.start < pos && pos < e.end) {
        // Bind to the affinity edge of the edit's output. Routing through
        // the boundary positions keeps the result consistent with any
        // insertions sharing the edit's endpoints. (Endpoints are never
        // strictly inside another edit, so this does not recurse.)
        return affinity === "left" ? toNew(e.start, "left") : toNew(e.end, "right");
      }
      const width = e.newEnd - e.newStart - (e.end - e.start);
      if (e.end <= pos && (affinity === "right" || e.start < pos)) {
        delta += width;
      }
    }
    return pos + delta;
  }

  function toOld(pos: number, affinity: Affinity = "left"): number {
    checkPosition(pos, text.length, "new");
    // Fiber lookup: toNew is non-decreasing, so binary-search the original
    // positions for the extreme preimage (min for left, max for right).
    let candidate: number;
    if (affinity === "left") {
      let lo = 0;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (toNew(mid, "left") >= pos) hi = mid;
        else lo = mid + 1;
      }
      candidate = lo;
    } else {
      let lo = 0;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (toNew(mid, "right") <= pos) lo = mid;
        else hi = mid - 1;
      }
      candidate = lo;
    }
    if (toNew(candidate, affinity) === pos) return candidate;
    // The fiber is empty: pos has no original counterpart. Positions
    // strictly inside a replaced interval's output bind to the affinity
    // edge of the original interval.
    for (const e of placed) {
      if (e.start < e.end && e.newStart < pos && pos < e.newEnd) {
        return affinity === "left" ? e.start : e.end;
      }
    }
    // Positions strictly inside an insertion run collapse to its point.
    for (const r of insertionRuns) {
      if (r.newStart < pos && pos < r.newEnd) {
        return r.point;
      }
    }
    // Boundary of inserted text: attach to the content on the affinity side.
    const image = toNew(candidate, affinity);
    if (affinity === "left") {
      return image > pos ? Math.max(0, candidate - 1) : candidate;
    }
    return image < pos ? Math.min(len, candidate + 1) : candidate;
  }

  return { original, text, toNew, toOld };
}
