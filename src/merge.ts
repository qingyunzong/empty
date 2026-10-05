/**
 * Three-way, line-number-based merge.
 *
 * Both sides are diffed against the common base; the resulting hunks live in
 * base line coordinates. Hunks that are merely adjacent (one ends exactly
 * where the other begins, including insertions at a hunk boundary) merge
 * cleanly. Hunks that overlap — including two insertions at the same point
 * with different content — produce a conflict whose marker block preserves
 * all three original ranges (ours / base / theirs), making the result
 * reversible: `unmerge(render(result))` reconstructs all three inputs.
 */

import { diffLines, type Hunk } from './diff.js';

export interface Conflict {
  /** Inclusive start line index into the base document. */
  baseStart: number;
  /** Exclusive end line index into the base document. */
  baseEnd: number;
  /** Original base lines in [baseStart, baseEnd). */
  baseLines: string[];
  /** Ours' replacement for that base range. */
  oursLines: string[];
  /** Theirs' replacement for that base range. */
  theirsLines: string[];
}

export type Segment =
  | { kind: 'clean'; lines: string[] }
  | {
      /** A region changed by one or both sides, applied cleanly. */
      kind: 'change';
      /** The applied (merged) lines. */
      lines: string[];
      /** Original base lines in the changed range. */
      baseLines: string[];
      /** Ours' content for the range (equals baseLines when ours did not touch it). */
      oursLines: string[];
      /** Theirs' content for the range (equals baseLines when theirs did not touch it). */
      theirsLines: string[];
    }
  | { kind: 'conflict'; conflict: Conflict };

export interface MergeLabels {
  ours: string;
  base: string;
  theirs: string;
}

export const DEFAULT_LABELS: MergeLabels = {
  ours: 'ours',
  base: 'base',
  theirs: 'theirs',
};

export interface MergeResult {
  /** True when no conflicts were produced. */
  clean: boolean;
  /** All conflicts, in document order. */
  conflicts: Conflict[];
  /** Structured, fully reversible representation of the merged document. */
  segments: Segment[];
  /** Merged document text with diff3-style conflict markers. */
  text: string;
}

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Does hunk `h` overlap the cluster covering base range [s, e)?
 * An insertion at point p overlaps only when strictly inside (s < p < e),
 * or when the cluster is itself an insertion at the same point. Insertions
 * at a cluster boundary (p === s or p === e) are adjacent, not overlapping.
 */
function overlaps(h: Hunk, s: number, e: number): boolean {
  if (h.baseStart === h.baseEnd) {
    const p = h.baseStart;
    return (s < p && p < e) || (s === e && p === s);
  }
  return h.baseStart < e && h.baseEnd > s;
}

/** Apply one side's hunks (within the cluster) to base range [s, e). */
function sideResult(base: string[], s: number, e: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let p = s;
  for (const h of hunks) {
    out.push(...base.slice(p, h.baseStart), ...h.lines);
    p = h.baseEnd;
  }
  out.push(...base.slice(p, e));
  return out;
}

/** Split text into lines, tolerating a single trailing newline. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Join lines back into document text (newline-terminated when non-empty). */
export function joinLines(lines: string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

export function merge3(
  base: string[],
  ours: string[],
  theirs: string[],
  labels: MergeLabels = DEFAULT_LABELS,
): MergeResult {
  const oh = diffLines(base, ours);
  const th = diffLines(base, theirs);
  const segments: Segment[] = [];
  const conflicts: Conflict[] = [];
  let i = 0;
  let j = 0;
  let pos = 0;

  const pushClean = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === 'clean') last.lines.push(...lines);
    else segments.push({ kind: 'clean', lines: [...lines] });
  };

  while (i < oh.length || j < th.length) {
    // Pick the next hunk: smallest baseStart; on ties, zero-width insertions
    // first so they are emitted before a replacement starting at the same
    // line; remaining ties prefer ours (deterministic, they cluster anyway).
    let first: Hunk;
    let firstIsOurs: boolean;
    const a = i < oh.length ? oh[i] : null;
    const b = j < th.length ? th[j] : null;
    if (a && b) {
      if (a.baseStart !== b.baseStart) {
        firstIsOurs = a.baseStart < b.baseStart;
      } else {
        const az = a.baseStart === a.baseEnd;
        const bz = b.baseStart === b.baseEnd;
        firstIsOurs = az === bz ? true : az;
      }
      first = firstIsOurs ? a : b;
    } else if (a) {
      first = a;
      firstIsOurs = true;
    } else {
      first = b!;
      firstIsOurs = false;
    }
    if (firstIsOurs) i++;
    else j++;

    const s = first.baseStart;
    let e = first.baseEnd;
    const oc: Hunk[] = firstIsOurs ? [first] : [];
    const tc: Hunk[] = firstIsOurs ? [] : [first];

    // Absorb every hunk overlapping the growing cluster [s, e).
    for (;;) {
      let grew = false;
      while (i < oh.length && overlaps(oh[i], s, e)) {
        e = Math.max(e, oh[i].baseEnd);
        oc.push(oh[i]);
        i++;
        grew = true;
      }
      while (j < th.length && overlaps(th[j], s, e)) {
        e = Math.max(e, th[j].baseEnd);
        tc.push(th[j]);
        j++;
        grew = true;
      }
      if (!grew) break;
    }

    pushClean(base.slice(pos, s));
    const oursLines = sideResult(base, s, e, oc);
    const theirsLines = sideResult(base, s, e, tc);
    const applied =
      oc.length === 0 ? theirsLines : tc.length === 0 ? oursLines : eq(oursLines, theirsLines) ? oursLines : null;
    if (applied !== null) {
      segments.push({
        kind: 'change',
        lines: applied,
        baseLines: base.slice(s, e),
        oursLines,
        theirsLines,
      });
    } else {
      const conflict: Conflict = {
        baseStart: s,
        baseEnd: e,
        baseLines: base.slice(s, e),
        oursLines,
        theirsLines,
      };
      conflicts.push(conflict);
      segments.push({ kind: 'conflict', conflict });
    }
    pos = e;
  }
  pushClean(base.slice(pos));

  const text = render({ segments }, labels);
  return { clean: conflicts.length === 0, conflicts, segments, text };
}

/** Render segments as document text with diff3-style conflict markers. */
export function render(
  result: Pick<MergeResult, 'segments'>,
  labels: MergeLabels = DEFAULT_LABELS,
): string {
  const out: string[] = [];
  for (const seg of result.segments) {
    if (seg.kind === 'clean') {
      out.push(...seg.lines);
    } else if (seg.kind === 'change') {
      out.push(...seg.lines);
    } else {
      const c = seg.conflict;
      out.push(`<<<<<<< ${labels.ours}`);
      out.push(...c.oursLines);
      out.push(`||||||| ${labels.base}`);
      out.push(...c.baseLines);
      out.push('=======');
      out.push(...c.theirsLines);
      out.push(`>>>>>>> ${labels.theirs}`);
    }
  }
  return joinLines(out);
}

/**
 * Inverse of `render`: parse a merged document (with conflict markers) and
 * reconstruct the three original documents. Clean regions are shared by all
 * three; conflict blocks carry each side's original lines.
 */
export function unmerge(text: string): {
  base: string[];
  ours: string[];
  theirs: string[];
} {
  const lines = splitLines(text);
  const base: string[] = [];
  const ours: string[] = [];
  const theirs: string[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`unmerge: line ${i + 1}: ${msg}`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('<<<<<<< ')) {
      base.push(line);
      ours.push(line);
      theirs.push(line);
      i++;
      continue;
    }
    i++;
    const o: string[] = [];
    while (i < lines.length && !lines[i].startsWith('||||||| ')) o.push(lines[i++]);
    if (i >= lines.length) fail('missing ||||||| base marker');
    i++;
    const b: string[] = [];
    while (i < lines.length && lines[i] !== '=======') b.push(lines[i++]);
    if (i >= lines.length) fail('missing ======= marker');
    i++;
    const t: string[] = [];
    while (i < lines.length && !lines[i].startsWith('>>>>>>> ')) t.push(lines[i++]);
    if (i >= lines.length) fail('missing >>>>>>> theirs marker');
    i++;
    ours.push(...o);
    base.push(...b);
    theirs.push(...t);
  }
  return { base, ours, theirs };
}

/** Reconstruct the three inputs from a structured MergeResult. */
export function reconstruct(result: MergeResult): {
  base: string[];
  ours: string[];
  theirs: string[];
} {
  const base: string[] = [];
  const ours: string[] = [];
  const theirs: string[] = [];
  for (const seg of result.segments) {
    if (seg.kind === 'clean') {
      base.push(...seg.lines);
      ours.push(...seg.lines);
      theirs.push(...seg.lines);
    } else if (seg.kind === 'change') {
      base.push(...seg.baseLines);
      ours.push(...seg.oursLines);
      theirs.push(...seg.theirsLines);
    } else {
      base.push(...seg.conflict.baseLines);
      ours.push(...seg.conflict.oursLines);
      theirs.push(...seg.conflict.theirsLines);
    }
  }
  return { base, ours, theirs };
}
