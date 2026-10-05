/**
 * Three-way, line-number-based merge.
 *
 * diffLines(base, ours) and diffLines(base, theirs) produce hunks keyed by
 * base line numbers. Hunks from the two sides that do not overlap (including
 * directly adjacent ones) are applied together; hunks that overlap — which
 * includes inserting different content at the very same point — become
 * conflict hunks that preserve the original base range plus both branches'
 * replacement lines, so the merge is fully reversible.
 */

import { diffLines, type Hunk } from './diff.js';

export interface Labels {
  ours: string;
  theirs: string;
  base: string;
}

export const DEFAULT_LABELS: Labels = { ours: 'ours', theirs: 'theirs', base: 'base' };

export interface CleanHunk {
  type: 'clean';
  /** Which side(s) introduced this change. */
  side: 'ours' | 'theirs' | 'both';
  baseStart: number;
  baseEnd: number;
  /** Original base lines, kept so the result is reversible. */
  baseLines: string[];
  lines: string[];
}

export interface ConflictHunk {
  type: 'conflict';
  baseStart: number;
  baseEnd: number;
  /** Original base lines of the conflicted range. */
  baseLines: string[];
  ours: string[];
  theirs: string[];
}

export type MergeHunk = CleanHunk | ConflictHunk;

export interface MergeResult {
  version: 1;
  labels: Labels;
  baseLineCount: number;
  clean: boolean;
  conflictCount: number;
  hunks: MergeHunk[];
  /** Merged document text; conflict hunks carry diff3-style markers. */
  merged: string;
}

export type Side = 'base' | 'ours' | 'theirs';

export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function joinLines(lines: string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** Half-open range overlap; an empty range overlaps only a point strictly inside. */
function overlaps(h: Hunk, start: number, end: number): boolean {
  const hEmpty = h.baseStart === h.baseEnd;
  const rangeEmpty = start === end;
  if (hEmpty && rangeEmpty) return h.baseStart === start;
  if (hEmpty) return start < h.baseStart && h.baseStart < end;
  if (rangeEmpty) return h.baseStart < start && start < h.baseEnd;
  return h.baseStart < end && start < h.baseEnd;
}

/** Apply one side's hunks inside [start, end) to the base slice. */
function sideContent(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.baseStart));
    out.push(...h.lines);
    pos = h.baseEnd;
  }
  out.push(...base.slice(pos, end));
  return out;
}

/** Core merge: returns hunks sorted by baseStart. */
export function mergeLines(base: string[], ours: string[], theirs: string[]): MergeHunk[] {
  const hunksOurs = diffLines(base, ours);
  const hunksTheirs = diffLines(base, theirs);
  const merged: MergeHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < hunksOurs.length || j < hunksTheirs.length) {
    const clusterOurs: Hunk[] = [];
    const clusterTheirs: Hunk[] = [];
    let start: number;
    let end: number;
    const takeOurs =
      j >= hunksTheirs.length ||
      (i < hunksOurs.length &&
        (hunksOurs[i].baseStart < hunksTheirs[j].baseStart ||
          (hunksOurs[i].baseStart === hunksTheirs[j].baseStart &&
            hunksOurs[i].baseEnd <= hunksTheirs[j].baseEnd)));
    if (takeOurs) {
      start = hunksOurs[i].baseStart;
      end = hunksOurs[i].baseEnd;
      clusterOurs.push(hunksOurs[i]);
      i++;
    } else {
      start = hunksTheirs[j].baseStart;
      end = hunksTheirs[j].baseEnd;
      clusterTheirs.push(hunksTheirs[j]);
      j++;
    }
    // Grow the cluster while either side has hunks overlapping its range.
    let grew = true;
    while (grew) {
      grew = false;
      while (i < hunksOurs.length && overlaps(hunksOurs[i], start, end)) {
        start = Math.min(start, hunksOurs[i].baseStart);
        end = Math.max(end, hunksOurs[i].baseEnd);
        clusterOurs.push(hunksOurs[i]);
        i++;
        grew = true;
      }
      while (j < hunksTheirs.length && overlaps(hunksTheirs[j], start, end)) {
        start = Math.min(start, hunksTheirs[j].baseStart);
        end = Math.max(end, hunksTheirs[j].baseEnd);
        clusterTheirs.push(hunksTheirs[j]);
        j++;
        grew = true;
      }
    }
    const baseLines = base.slice(start, end);
    const oursContent = sideContent(base, start, end, clusterOurs);
    const theirsContent = sideContent(base, start, end, clusterTheirs);
    if (clusterTheirs.length === 0) {
      merged.push({ type: 'clean', side: 'ours', baseStart: start, baseEnd: end, baseLines, lines: oursContent });
    } else if (clusterOurs.length === 0) {
      merged.push({ type: 'clean', side: 'theirs', baseStart: start, baseEnd: end, baseLines, lines: theirsContent });
    } else if (arraysEqual(oursContent, theirsContent)) {
      merged.push({ type: 'clean', side: 'both', baseStart: start, baseEnd: end, baseLines, lines: oursContent });
    } else {
      merged.push({ type: 'conflict', baseStart: start, baseEnd: end, baseLines, ours: oursContent, theirs: theirsContent });
    }
  }
  return merged;
}

/** Render merged lines; conflicts use diff3-style markers that record all three ranges. */
export function renderMerged(base: string[], hunks: MergeHunk[], labels: Labels = DEFAULT_LABELS): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.baseStart));
    if (h.type === 'clean') {
      out.push(...h.lines);
    } else {
      out.push(`<<<<<<< ${labels.ours}`);
      out.push(...h.ours);
      out.push(`||||||| ${labels.base}`);
      out.push(...h.baseLines);
      out.push('=======');
      out.push(...h.theirs);
      out.push(`>>>>>>> ${labels.theirs}`);
    }
    pos = h.baseEnd;
  }
  out.push(...base.slice(pos));
  return out;
}

export function merge3(
  baseText: string,
  oursText: string,
  theirsText: string,
  labels: Labels = DEFAULT_LABELS,
): MergeResult {
  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  const hunks = mergeLines(base, ours, theirs);
  const conflictCount = hunks.filter((h) => h.type === 'conflict').length;
  return {
    version: 1,
    labels,
    baseLineCount: base.length,
    clean: conflictCount === 0,
    conflictCount,
    hunks,
    merged: joinLines(renderMerged(base, hunks, labels)),
  };
}

export interface RevertableResult {
  baseLineCount: number;
  hunks: MergeHunk[];
}

function expectLines(actual: string[], expected: string[], what: string): void {
  if (!arraysEqual(actual, expected)) {
    throw new Error(
      `revert: merged text does not match recorded ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function expectMarker(line: string | undefined, marker: string): void {
  if (line === undefined || !line.startsWith(marker)) {
    throw new Error(`revert: expected marker "${marker}" but found ${JSON.stringify(line)}`);
  }
}

/**
 * Reverse a merge: given the merged text and the merge result, reconstruct
 * any of the three input documents. Every hunk records its base range and
 * all branches' content, so the operation is lossless; mismatches between
 * the merged text and the recorded result raise an error.
 */
export function revert(mergedText: string, result: RevertableResult, side: Side): string {
  const mergedLines = splitLines(mergedText);
  const out: string[] = [];
  let cursor = 0;
  let basePos = 0;
  for (const h of result.hunks) {
    const gap = h.baseStart - basePos;
    if (gap < 0) throw new Error('revert: hunks are not sorted by base range');
    out.push(...mergedLines.slice(cursor, cursor + gap));
    cursor += gap;
    if (h.type === 'clean') {
      expectLines(mergedLines.slice(cursor, cursor + h.lines.length), h.lines, 'clean hunk content');
      cursor += h.lines.length;
      const fromSide = h.side === 'both' || h.side === side;
      out.push(...(side === 'base' || !fromSide ? h.baseLines : h.lines));
    } else {
      expectMarker(mergedLines[cursor], '<<<<<<<');
      expectLines(mergedLines.slice(cursor + 1, cursor + 1 + h.ours.length), h.ours, 'conflict "ours" lines');
      let p = cursor + 1 + h.ours.length;
      expectMarker(mergedLines[p], '|||||||');
      expectLines(mergedLines.slice(p + 1, p + 1 + h.baseLines.length), h.baseLines, 'conflict base lines');
      p += 1 + h.baseLines.length;
      if (mergedLines[p] !== '=======') throw new Error(`revert: expected marker "=======" but found ${JSON.stringify(mergedLines[p])}`);
      expectLines(mergedLines.slice(p + 1, p + 1 + h.theirs.length), h.theirs, 'conflict "theirs" lines');
      p += 1 + h.theirs.length;
      expectMarker(mergedLines[p], '>>>>>>>');
      cursor = p + 1;
      out.push(...(side === 'base' ? h.baseLines : side === 'ours' ? h.ours : h.theirs));
    }
    basePos = h.baseEnd;
  }
  const rest = mergedLines.slice(cursor);
  if (rest.length !== result.baseLineCount - basePos) {
    throw new Error(
      `revert: trailing context has ${rest.length} lines, expected ${result.baseLineCount - basePos}`,
    );
  }
  out.push(...rest);
  return joinLines(out);
}
