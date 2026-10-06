/**
 * Single-line scanner for the document index.
 *
 * Each line is classified with the fence state carried from the previous
 * line, producing a `LineScan` that records:
 *  - the fence state before/after the line (drives incremental rescans),
 *  - headings, explicit anchors and internal references found on the line.
 *
 * Everything inside a fenced code block (``` or ~~~) is ignored.
 */

export type FenceState =
  | { readonly open: false }
  | { readonly open: true; readonly char: "`" | "~"; readonly length: number };

export const OUTSIDE: FenceState = { open: false };

export interface HeadingHit {
  readonly level: number;
  readonly text: string;
}

export interface RefHit {
  readonly text: string;
  readonly target: string;
}

export interface LineScan {
  readonly stateBefore: FenceState;
  readonly stateAfter: FenceState;
  readonly headings: readonly HeadingHit[];
  readonly anchors: readonly string[];
  readonly refs: readonly RefHit[];
}

export function sameFenceState(a: FenceState, b: FenceState): boolean {
  if (a.open !== b.open) return false;
  if (!a.open || !b.open) return true;
  return a.char === b.char && a.length === b.length;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const CLOSING_HASHES_RE = /[ \t]+#+[ \t]*$/;
const ANCHOR_RE = /<a\s+(?:name|id)\s*=\s*["']([^"']+)["'][^>]*>/gi;
const LINK_RE = /\[([^\]\n]*)\]\(\s*#([^)\s]*)\s*\)/g;

interface FenceMark {
  readonly char: "`" | "~";
  readonly length: number;
  readonly info: string;
}

function matchFence(line: string): FenceMark | null {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  const run = m[1];
  const info = m[2].trim();
  return { char: run[0] as "`" | "~", length: run.length, info };
}

/** An opening fence: backtick fences may not contain "`" in the info string. */
function asOpening(mark: FenceMark): FenceMark | null {
  if (mark.char === "`" && mark.info.includes("`")) return null;
  return mark;
}

/** A closing fence: same char, at least as long, and no info string. */
function isClosing(mark: FenceMark, state: FenceState & { open: true }): boolean {
  return mark.char === state.char && mark.length >= state.length && mark.info === "";
}

function parseHeading(line: string): HeadingHit | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const raw = (m[2] ?? "").replace(CLOSING_HASHES_RE, "").trim();
  return { level: m[1].length, text: raw };
}

function collect(line: string, re: RegExp, map: (m: RegExpExecArray) => string): string[] {
  re.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(map(m));
  return out;
}

const EMPTY: LineScan = {
  stateBefore: OUTSIDE,
  stateAfter: OUTSIDE,
  headings: [],
  anchors: [],
  refs: [],
};

export function scanLine(line: string, stateBefore: FenceState): LineScan {
  if (stateBefore.open) {
    const mark = matchFence(line);
    const closes = mark !== null && isClosing(mark, stateBefore);
    // Inside a fence (or on its closing delimiter): nothing is extracted.
    return { ...EMPTY, stateBefore, stateAfter: closes ? OUTSIDE : stateBefore };
  }

  const opening = matchFence(line);
  if (opening !== null && asOpening(opening) !== null) {
    const stateAfter: FenceState = {
      open: true,
      char: opening.char,
      length: opening.length,
    };
    return { ...EMPTY, stateBefore, stateAfter };
  }

  const heading = parseHeading(line);
  if (heading !== null) {
    return { ...EMPTY, stateBefore, stateAfter: OUTSIDE, headings: [heading] };
  }

  const anchors = collect(line, ANCHOR_RE, (m) => m[1]);
  const refs: RefHit[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(line)) !== null) {
    refs.push({ text: m[1], target: m[2] });
  }
  return { stateBefore, stateAfter: OUTSIDE, headings: [], anchors, refs };
}
