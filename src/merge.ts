/**
 * Three-way merge of byte-range patches.
 *
 * Both branches describe their changes as edits against the same base
 * (original) version. An edit replaces base[start:end] with `text`
 * (start === end is an insertion, text === "" is a deletion).
 *
 * Merge rules:
 *  - identical edits on both sides are applied once;
 *  - non-overlapping edits are all applied;
 *  - insertions at the same point are both kept, ordered by branch id;
 *  - overlapping edits with different content conflict;
 *  - a deletion conflicts with any modification strictly inside it.
 */

export interface Edit {
  /** Inclusive start offset in the base version. */
  start: number;
  /** Exclusive end offset in the base version. */
  end: number;
  /** Replacement text ("" for deletion). */
  text: string;
}

export interface EditConflict {
  a: Edit;
  b: Edit;
}

export interface MergeOk {
  ok: true;
  /** Merged edits, sorted by base offset, non-overlapping. */
  edits: Edit[];
  /** Result of applying `edits` to the base version. */
  text: string;
  /** Bidirectional position mapping between base and merged text. */
  map: PositionMap;
}

export interface MergeConflicted {
  ok: false;
  conflicts: EditConflict[];
}

export type MergeResult = MergeOk | MergeConflicted;

function sameEdit(a: Edit, b: Edit): boolean {
  return a.start === b.start && a.end === b.end && a.text === b.text;
}

function checkEdit(base: string, e: Edit): void {
  if (
    !Number.isInteger(e.start) ||
    !Number.isInteger(e.end) ||
    e.start < 0 ||
    e.start > e.end ||
    e.end > base.length
  ) {
    throw new RangeError(
      `edit [${e.start}, ${e.end}) out of bounds for base length ${base.length}`,
    );
  }
}

/**
 * Sorts edits by base offset and combines any that overlap within the
 * single side, so the result is a non-overlapping patch on the base.
 */
export function normalizeEdits(base: string, edits: readonly Edit[]): Edit[] {
  const sorted = edits
    .map((e) => ({ start: e.start, end: e.end, text: e.text }))
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const out: Edit[] = [];
  for (const e of sorted) {
    checkEdit(base, e);
    const last = out[out.length - 1];
    if (last && e.start < last.end) {
      const pre = last.text.slice(0, e.start - last.start);
      if (e.end <= last.end) {
        last.text = pre + e.text + last.text.slice(e.end - last.start);
      } else {
        last.text = pre + e.text;
        last.end = e.end;
      }
    } else {
      out.push(e);
    }
  }
  return out;
}

/** Applies a non-overlapping, base-offset-sorted patch to the base text. */
export function applyEdits(base: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((x, y) => x.start - y.start || x.end - y.end);
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    checkEdit(base, e);
    out += base.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + base.slice(pos);
}

/**
 * Merges two branches' patches against the common `base` version.
 * Branch ids break ties between insertions at the same offset: the
 * lexicographically smaller branch id contributes its text first.
 */
export function merge(
  base: string,
  editsA: readonly Edit[],
  editsB: readonly Edit[],
  branchA = "a",
  branchB = "b",
): MergeResult {
  const a = normalizeEdits(base, editsA);
  const b = normalizeEdits(base, editsB);
  const edits: Edit[] = [];
  const conflicts: EditConflict[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ea = a[i]!;
    const eb = b[j]!;
    if (sameEdit(ea, eb)) {
      edits.push({ ...ea });
      i++;
      j++;
    } else if (ea.start === ea.end && eb.start === eb.end && ea.start === eb.start) {
      const first = branchA <= branchB ? ea : eb;
      const second = branchA <= branchB ? eb : ea;
      edits.push({ ...first }, { ...second });
      i++;
      j++;
    } else if (ea.end <= eb.start) {
      edits.push({ ...ea });
      i++;
    } else if (eb.end <= ea.start) {
      edits.push({ ...eb });
      j++;
    } else {
      conflicts.push({ a: { ...ea }, b: { ...eb } });
      if (ea.end < eb.end) i++;
      else if (eb.end < ea.end) j++;
      else {
        i++;
        j++;
      }
    }
  }
  while (i < a.length) edits.push({ ...a[i++]! });
  while (j < b.length) edits.push({ ...b[j++]! });
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  const map = new PositionMap(base.length, edits);
  return { ok: true, edits, text: applyEdits(base, edits), map };
}

/**
 * Bidirectional offset mapping between the base version and the merged
 * text. Offsets strictly inside a replaced/deleted base range have no
 * merged counterpart (and vice versa for inserted text); those map to
 * null. Boundary offsets map to the corresponding boundary.
 */
export class PositionMap {
  readonly mergedLength: number;
  private readonly edits: Edit[];
  private readonly outStarts: number[];

  constructor(
    readonly baseLength: number,
    edits: readonly Edit[],
  ) {
    this.edits = edits.map((e) => ({ ...e }));
    this.outStarts = [];
    let delta = 0;
    for (const e of this.edits) {
      this.outStarts.push(e.start + delta);
      delta += e.text.length - (e.end - e.start);
    }
    this.mergedLength = baseLength + delta;
  }

  /** Maps a base offset to a merged-text offset, or null if it was replaced/deleted. */
  toMerged(offset: number): number | null {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.baseLength) {
      throw new RangeError(`offset ${offset} out of bounds for base length ${this.baseLength}`);
    }
    let delta = 0;
    for (let k = 0; k < this.edits.length; k++) {
      const e = this.edits[k]!;
      if (offset < e.start) return offset + delta;
      const outStart = this.outStarts[k]!;
      if (offset === e.start) return outStart;
      if (offset < e.end) return null;
      if (offset === e.end) return outStart + e.text.length;
      delta += e.text.length - (e.end - e.start);
    }
    return offset + delta;
  }

  /** Maps a merged-text offset to a base offset, or null if it is inserted text. */
  toOriginal(offset: number): number | null {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.mergedLength) {
      throw new RangeError(`offset ${offset} out of bounds for merged length ${this.mergedLength}`);
    }
    let delta = 0;
    for (let k = 0; k < this.edits.length; k++) {
      const e = this.edits[k]!;
      const outStart = this.outStarts[k]!;
      const outEnd = outStart + e.text.length;
      if (offset < outStart) return offset - delta;
      if (offset === outStart) return e.start;
      if (offset < outEnd) return null;
      if (offset === outEnd) return e.end;
      delta += e.text.length - (e.end - e.start);
    }
    return offset - delta;
  }
}
