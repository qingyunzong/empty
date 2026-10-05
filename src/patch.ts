/**
 * context-patch: context-anchored patching.
 *
 * Input: a baseline document, a (possibly already modified) target document,
 * and patch specs given as [start, end) ranges into the baseline plus a
 * replacement string. Each patch is relocated in the target by its original
 * content and surrounding context. Ambiguous locations are reported, never
 * guessed. A set of patches is validated as a whole and applied atomically.
 * The result carries a reverse patch set and per-patch location evidence.
 */

export interface PatchSpec {
  /** Start offset (inclusive) into the baseline document. */
  start: number;
  /** End offset (exclusive) into the baseline document. */
  end: number;
  /** Text that replaces baseline[start:end]. */
  replacement: string;
}

export interface ApplyOptions {
  /**
   * Initial context radius (characters on each side) used when the original
   * content itself cannot be found verbatim. Grows geometrically up to the
   * available context. Default 16.
   */
  contextRadius?: number;
  /**
   * Maximum gap allowed between the before/after context anchors when the
   * original content was itself modified. Default: max(64, 4 * original length).
   */
  maxGap?: number;
}

export interface CandidateEvidence {
  /** Candidate start offset in the target. */
  position: number;
  /** Candidate end offset in the target. */
  end: number;
  /** Characters of baseline context matched immediately before the candidate. */
  matchedBefore: number;
  /** Characters of baseline context matched immediately after the candidate. */
  matchedAfter: number;
}

export type LocateMode =
  | 'unchanged'           // target === baseline, range used verbatim
  | 'exact'               // original content occurs exactly once in target
  | 'exact-disambiguated' // several occurrences, unique best context match
  | 'context-anchored';   // content not found verbatim, located via anchors

export interface PatchEvidence {
  /** Index of the patch spec in the input array. */
  index: number;
  /** The baseline slice the patch refers to. */
  original: string;
  /** Where the patch was located in the target. */
  range: { start: number; end: number };
  mode: LocateMode;
  /** Every candidate position that was enumerated and checked. */
  candidates: CandidateEvidence[];
  /** Context anchors actually used (context-anchored mode). */
  contextBefore: string;
  contextAfter: string;
}

export interface ReversePatch {
  /** Start offset into the patched result. */
  start: number;
  /** End offset into the patched result. */
  end: number;
  /** Original content; splicing it back restores the target. */
  replacement: string;
}

export type PatchError =
  | { kind: 'invalid-range'; index: number; start: number; end: number; baselineLength: number }
  | { kind: 'not-found'; index: number; original: string }
  | { kind: 'ambiguous'; index: number; original: string; candidates: CandidateEvidence[] }
  | { kind: 'overlap'; indexA: number; indexB: number };

export type ApplyResult =
  | { ok: true; result: string; evidence: PatchEvidence[]; reverse: ReversePatch[] }
  | { ok: false; errors: PatchError[]; evidence: PatchEvidence[] };

interface Located {
  index: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
  evidence: PatchEvidence;
}

function allOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return out;
    out.push(i);
    from = i + 1;
  }
}

function contextScores(
  baseline: string, start: number, end: number,
  target: string, pos: number, posEnd: number,
): { matchedBefore: number; matchedAfter: number } {
  let matchedBefore = 0;
  while (
    start - matchedBefore - 1 >= 0 &&
    pos - matchedBefore - 1 >= 0 &&
    baseline[start - matchedBefore - 1] === target[pos - matchedBefore - 1]
  ) matchedBefore++;
  let matchedAfter = 0;
  while (
    end + matchedAfter < baseline.length &&
    posEnd + matchedAfter < target.length &&
    baseline[end + matchedAfter] === target[posEnd + matchedAfter]
  ) matchedAfter++;
  return { matchedBefore, matchedAfter };
}

type LocateOutcome =
  | { ok: true; start: number; end: number; evidence: PatchEvidence }
  | { ok: false; error: PatchError; evidence?: PatchEvidence };

function locate(
  baseline: string, target: string, index: number, spec: PatchSpec, options: ApplyOptions,
): LocateOutcome {
  const { start, end } = spec;
  if (
    !Number.isInteger(start) || !Number.isInteger(end) ||
    start < 0 || end < start || end > baseline.length
  ) {
    return { ok: false, error: { kind: 'invalid-range', index, start, end, baselineLength: baseline.length } };
  }
  const original = baseline.slice(start, end);

  if (target === baseline) {
    const evidence: PatchEvidence = {
      index, original, range: { start, end }, mode: 'unchanged',
      candidates: [{ position: start, end, matchedBefore: 0, matchedAfter: 0 }],
      contextBefore: '', contextAfter: '',
    };
    return { ok: true, start, end, evidence };
  }

  // Phase 1: enumerate every verbatim occurrence of the original content.
  // For small repeated strings this is the full enumeration; each candidate
  // is scored against the baseline context and only a unique best wins.
  if (original.length > 0) {
    const positions = allOccurrences(target, original);
    if (positions.length > 0) {
      const candidates: CandidateEvidence[] = positions.map((pos) => {
        const s = contextScores(baseline, start, end, target, pos, pos + original.length);
        return { position: pos, end: pos + original.length, ...s };
      });
      const bestScore = Math.max(...candidates.map((c) => c.matchedBefore + c.matchedAfter));
      const winners = candidates.filter(
        (c) => c.matchedBefore + c.matchedAfter === bestScore,
      );
      if (winners.length === 1) {
        const best = winners[0]!;
        const mode: LocateMode = positions.length === 1 ? 'exact' : 'exact-disambiguated';
        const evidence: PatchEvidence = {
          index, original, range: { start: best.position, end: best.end }, mode,
          candidates, contextBefore: '', contextAfter: '',
        };
        return { ok: true, start: best.position, end: best.end, evidence };
      }
      return {
        ok: false,
        error: { kind: 'ambiguous', index, original, candidates: winners },
      };
    }
  }

  // Phase 2: the original content is absent verbatim (or the patch is a pure
  // insertion). Anchor on the surrounding context, allowing a bounded gap
  // between the anchors. Grow the anchors until the location is unique or
  // the whole document context is exhausted.
  const maxGap = options.maxGap ?? Math.max(64, original.length * 4);
  const availBefore = start;
  const availAfter = baseline.length - end;
  let radius = Math.max(1, options.contextRadius ?? 16);
  let lastCandidates: CandidateEvidence[] = [];
  for (;;) {
    const r = Math.min(radius, Math.max(availBefore, availAfter));
    const before = baseline.slice(Math.max(0, start - r), start);
    const after = baseline.slice(end, Math.min(baseline.length, end + r));
    const candidates: CandidateEvidence[] = [];
    const seen = new Set<string>();
    for (const pos of allOccurrences(target, before)) {
      const gapStart = pos + before.length;
      const limit = Math.min(target.length, gapStart + maxGap);
      const afterPos = after.length === 0
        ? gapStart
        : target.indexOf(after, gapStart);
      if (afterPos === -1 || afterPos > limit) continue;
      const key = gapStart + ':' + afterPos;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        position: gapStart, end: afterPos,
        matchedBefore: before.length, matchedAfter: after.length,
      });
    }
    if (candidates.length === 1) {
      const c = candidates[0]!;
      const evidence: PatchEvidence = {
        index, original, range: { start: c.position, end: c.end },
        mode: 'context-anchored', candidates,
        contextBefore: before, contextAfter: after,
      };
      return { ok: true, start: c.position, end: c.end, evidence };
    }
    if (candidates.length === 0) {
      // Longer anchors are strictly more restrictive: zero stays zero.
      return { ok: false, error: { kind: 'not-found', index, original } };
    }
    lastCandidates = candidates;
    if (r >= Math.max(availBefore, availAfter)) break; // context exhausted
    radius = r * 2;
  }
  return {
    ok: false,
    error: { kind: 'ambiguous', index, original, candidates: lastCandidates },
  };
}

/**
 * Validate every patch against the target, then apply them all atomically.
 * On any failure nothing is applied and all errors are reported.
 */
export function applyPatches(
  baseline: string,
  target: string,
  specs: PatchSpec[],
  options: ApplyOptions = {},
): ApplyResult {
  const located: Located[] = [];
  const errors: PatchError[] = [];
  const evidence: PatchEvidence[] = [];

  specs.forEach((spec, i) => {
    const r = locate(baseline, target, i, spec, options);
    if (r.ok) {
      located.push({
        index: i, start: r.start, end: r.end,
        // The reverse patch must restore what the target actually contained,
        // which may differ from the baseline slice (context-anchored mode).
        original: target.slice(r.start, r.end),
        replacement: spec.replacement, evidence: r.evidence,
      });
      evidence.push(r.evidence);
    } else {
      errors.push(r.error);
      if (r.evidence) evidence.push(r.evidence);
    }
  });

  located.sort((a, b) => a.start - b.start || a.index - b.index);
  for (let i = 0; i + 1 < located.length; i++) {
    const a = located[i]!;
    const b = located[i + 1]!;
    if (a.end > b.start) {
      errors.push({ kind: 'overlap', indexA: a.index, indexB: b.index });
    }
  }

  if (errors.length > 0) return { ok: false, errors, evidence };

  // All patches validated: apply left to right, tracking the offset shift so
  // reverse patches can be expressed in result coordinates.
  let result = '';
  let cursor = 0;
  let shift = 0;
  const reverse: ReversePatch[] = [];
  for (const p of located) {
    result += target.slice(cursor, p.start) + p.replacement;
    const rStart = p.start + shift;
    reverse.push({ start: rStart, end: rStart + p.replacement.length, replacement: p.original });
    shift += p.replacement.length - (p.end - p.start);
    cursor = p.end;
  }
  result += target.slice(cursor);
  return { ok: true, result, evidence, reverse };
}

/**
 * Undo a successful applyPatches call: splice the reverse patches into the
 * patched document. Ranges are exact positions in the patched document.
 */
export function revert(patched: string, reverse: ReversePatch[]): string {
  const sorted = [...reverse].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const r of sorted) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) ||
        r.start < cursor || r.end < r.start || r.end > patched.length) {
      throw new RangeError(`invalid reverse patch [${r.start}, ${r.end})`);
    }
    out += patched.slice(cursor, r.start) + r.replacement;
    cursor = r.end;
  }
  return out + patched.slice(cursor);
}

/** Human-readable location evidence, one block per patch. */
export function formatEvidence(evidence: PatchEvidence[]): string {
  const lines: string[] = [];
  for (const e of evidence) {
    lines.push(
      `patch #${e.index} [${e.mode}] located at [${e.range.start}, ${e.range.end}) ` +
      `original=${JSON.stringify(e.original)}`,
    );
    if (e.contextBefore || e.contextAfter) {
      lines.push(
        `  anchors: before=${JSON.stringify(e.contextBefore)} after=${JSON.stringify(e.contextAfter)}`,
      );
    }
    for (const c of e.candidates) {
      lines.push(
        `  candidate [${c.position}, ${c.end}) context-match before=${c.matchedBefore} after=${c.matchedAfter}`,
      );
    }
  }
  return lines.join('\n');
}
