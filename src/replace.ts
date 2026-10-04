import { canonicalizeUrl, Canonicalization, QueryParamMapping } from './canonicalize.js';

export interface Edit {
  start: number; // original offset, inclusive
  end: number; // original offset, exclusive
  text: string; // replacement text
}

// Apply every edit or none: all ranges are validated (bounds + no overlap)
// before anything is spliced, so a bad batch leaves the input untouched.
export function applyEditsAtomic(raw: string, edits: Edit[]): string {
  const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (const e of sorted) {
    if (
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < 0 ||
      e.end < e.start ||
      e.end > raw.length
    ) {
      throw new RangeError(`invalid edit range [${e.start}, ${e.end}); no edits applied`);
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new RangeError(
        `overlapping edits at [${sorted[i - 1].start}, ${sorted[i - 1].end}) and ` +
          `[${sorted[i].start}, ${sorted[i].end}); no edits applied`,
      );
    }
  }
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    out += raw.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + raw.slice(pos);
}

// Build the edit that replaces one parameter's value using its ORIGINAL span.
// For a bare key (no '='), the whole original pair is replaced by key=value.
export function editForParamValue(
  raw: string,
  param: QueryParamMapping,
  newValue: string,
): Edit {
  if (param.origValue) {
    return { start: param.origValue.start, end: param.origValue.end, text: newValue };
  }
  return {
    start: param.origPair.start,
    end: param.origPair.end,
    text: `${raw.slice(param.origKey.start, param.origKey.end)}=${newValue}`,
  };
}

// Replace signed fields by their original ranges and re-canonicalize.
// Multiple replacements are validated and applied atomically.
export function replaceParamValues(
  raw: string,
  c: Canonicalization,
  replacements: Array<{ canonIndex: number; newValue: string }>,
): Canonicalization {
  const edits = replacements.map((r) => {
    const param = c.params.find((p) => p.canonIndex === r.canonIndex);
    if (!param) {
      throw new RangeError(`no query parameter with canonical index ${r.canonIndex}`);
    }
    return editForParamValue(raw, param, r.newValue);
  });
  return canonicalizeUrl(applyEditsAtomic(raw, edits));
}
