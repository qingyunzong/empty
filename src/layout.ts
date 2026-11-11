import type { PlacedSubtitle, Subtitle } from "./types.js";

/**
 * Half-open time-interval overlap. Intervals that only touch at an
 * endpoint (a.end === b.start) do NOT overlap.
 */
export function timeOverlaps(a: Subtitle, b: Subtitle): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Half-open horizontal pixel-interval overlap. Intervals that only touch
 * at an endpoint (a.x1 === b.x0) do NOT overlap.
 */
export function horizontalOverlaps(a: Subtitle, b: Subtitle): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1;
}

/**
 * Two subtitles conflict — and therefore may not share any line — iff
 * they overlap in time AND in horizontal pixels.
 */
export function conflicts(a: Subtitle, b: Subtitle): boolean {
  return timeOverlaps(a, b) && horizontalOverlaps(a, b);
}

/** Deterministic order: start time ascending, ties broken by id. */
export function compareSubtitles(a: Subtitle, b: Subtitle): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Smallest line >= subtitle.preferredLine whose occupied range
 * [line, line + lineHeight) does not intersect the occupied range of any
 * already-placed conflicting subtitle.
 */
function smallestLegalLine(
  subtitle: Subtitle,
  placed: readonly PlacedSubtitle[],
): number {
  let line = subtitle.preferredLine;
  for (;;) {
    let pushTo = -1;
    for (const other of placed) {
      if (!conflicts(subtitle, other.subtitle)) continue;
      const otherEnd = other.line + other.subtitle.lineHeight;
      // Ranges [line, line+height) and [other.line, otherEnd) intersect?
      if (line < otherEnd && other.line < line + subtitle.lineHeight) {
        if (otherEnd > pushTo) pushTo = otherEnd;
      }
    }
    if (pushTo < 0) return line;
    line = pushTo;
  }
}

/**
 * Greedy line assignment: in (start, id) order, each subtitle receives
 * the smallest legal starting line that is >= its preferred line.
 *
 * `alreadyPlaced` may carry fixed placements (kept from a previous
 * layout) that must be respected but are not re-assigned.
 */
export function assignLines(
  subtitles: readonly Subtitle[],
  alreadyPlaced: readonly PlacedSubtitle[] = [],
): Map<string, number> {
  const placed: PlacedSubtitle[] = [...alreadyPlaced];
  const lines = new Map<string, number>();
  const sorted = [...subtitles].sort(compareSubtitles);
  for (const subtitle of sorted) {
    const line = smallestLegalLine(subtitle, placed);
    lines.set(subtitle.id, line);
    placed.push({ subtitle, line });
  }
  return lines;
}

/** Full layout of a subtitle set from scratch. */
export function layoutAll(
  subtitles: readonly Subtitle[],
): Map<string, number> {
  return assignLines(subtitles);
}

/**
 * Connected component of `seeds` in the time-overlap graph over the
 * union of the old and new subtitle sets.
 *
 * Every id present in either set contributes its interval(s) — an id
 * whose timing changed contributes both its old and its new interval —
 * and two ids are adjacent when any of their intervals overlap in time.
 * The component therefore contains every subtitle whose line assignment
 * could transitively depend on a changed subtitle (conflict edges are a
 * subset of time-overlap edges), and nothing outside it.
 */
export function affectedComponent(
  oldSubtitles: ReadonlyMap<string, Subtitle>,
  newSubtitles: ReadonlyMap<string, Subtitle>,
  seeds: ReadonlySet<string>,
): Set<string> {
  interface Interval {
    readonly id: string;
    readonly start: number;
    readonly end: number;
  }
  const intervals: Interval[] = [];
  const ids = new Set<string>([...oldSubtitles.keys(), ...newSubtitles.keys()]);
  for (const id of ids) {
    const oldSub = oldSubtitles.get(id);
    const newSub = newSubtitles.get(id);
    if (oldSub !== undefined) {
      intervals.push({ id, start: oldSub.start, end: oldSub.end });
    }
    if (
      newSub !== undefined &&
      (oldSub === undefined ||
        oldSub.start !== newSub.start ||
        oldSub.end !== newSub.end)
    ) {
      intervals.push({ id, start: newSub.start, end: newSub.end });
    }
  }

  // Union-find over ids.
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression.
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const a = intervals[i];
      const b = intervals[j];
      if (a.id === b.id) continue;
      if (a.start < b.end && b.start < a.end) union(a.id, b.id);
    }
  }

  const component = new Set<string>();
  const seedRoots = new Set<string>();
  for (const seed of seeds) {
    if (parent.has(seed)) seedRoots.add(find(seed));
  }
  if (seedRoots.size === 0) return component;
  for (const id of ids) {
    if (seedRoots.has(find(id))) component.add(id);
  }
  return component;
}
