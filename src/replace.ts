import type { MatchInfo, Range } from "./types.js";
import {
  BudgetExceededError,
  InvalidCaptureError,
  InvalidMatchesError,
} from "./errors.js";
import { parseTemplate, type TemplateToken } from "./template.js";
import { SourceMap, type Segment } from "./map.js";

export interface ReplaceOptions {
  /** Maximum allowed output length; exceeding it aborts the operation. */
  budget?: number;
}

export interface ReplaceResult {
  text: string;
  /** Maps positions in `text` back to positions in the input source. */
  map: SourceMap;
}

interface NormalizedMatch {
  start: number;
  end: number;
  captures: ReadonlyArray<Range | undefined>;
}

function normalizeMatches(
  source: string,
  matches: MatchInfo[],
): NormalizedMatch[] {
  const out: NormalizedMatch[] = [];
  let prevEnd = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (
      !Number.isInteger(m.start) ||
      !Number.isInteger(m.end) ||
      m.start < 0 ||
      m.end < m.start ||
      m.end > source.length
    ) {
      throw new InvalidMatchesError(
        `Match ${i} has out-of-bounds range [${m.start}, ${m.end})`,
      );
    }
    if (m.start < prevEnd) {
      throw new InvalidMatchesError(
        `Match ${i} overlaps or is unsorted: starts at ${m.start}, ` +
          `previous match ends at ${prevEnd}`,
      );
    }
    const captures: Array<Range | undefined> = (m.captures ?? []).map((c) =>
      c === undefined ? undefined : { start: c.start, end: c.end },
    );
    if (captures[0] === undefined) {
      captures[0] = { start: m.start, end: m.end };
    } else if (
      captures[0].start !== m.start ||
      captures[0].end !== m.end
    ) {
      throw new InvalidMatchesError(
        `Match ${i}: captures[0] must equal the whole match range`,
      );
    }
    for (let g = 0; g < captures.length; g++) {
      const c = captures[g];
      if (c === undefined) continue;
      if (c.start < 0 || c.end < c.start || c.end > source.length) {
        throw new InvalidMatchesError(
          `Match ${i}: capture ${g} out of bounds [${c.start}, ${c.end})`,
        );
      }
    }
    out.push({ start: m.start, end: m.end, captures });
    prevEnd = m.end;
  }
  return out;
}

function validateCaptures(
  matches: NormalizedMatch[],
  tokens: TemplateToken[],
): void {
  for (const token of tokens) {
    if (token.kind !== "capture") continue;
    for (let i = 0; i < matches.length; i++) {
      const caps = matches[i].captures;
      if (token.index >= caps.length) {
        throw new InvalidCaptureError(
          `Match ${i}: template references $${token.index} but only ` +
            `${caps.length} capture(s) exist`,
        );
      }
      if (caps[token.index] === undefined) {
        throw new InvalidCaptureError(
          `Match ${i}: capture group $${token.index} did not participate`,
        );
      }
    }
  }
}

/**
 * Expands `template` over the given non-overlapping matches of `source`,
 * returning the new text plus a mapping back to the source.
 *
 * The operation is atomic: any invalid capture reference, malformed
 * template, invalid match list, or budget overflow throws before a result
 * is produced, so the caller's state is never partially modified.
 */
export function replaceAll(
  source: string,
  matches: MatchInfo[],
  template: string,
  options: ReplaceOptions = {},
): ReplaceResult {
  const tokens = parseTemplate(template);
  const normalized = normalizeMatches(source, matches);
  validateCaptures(normalized, tokens);

  const pieces: string[] = [];
  const segments: Segment[] = [];
  let outLen = 0;

  const emit = (text: string, src: Range | null): void => {
    if (text.length === 0) return;
    pieces.push(text);
    segments.push({
      out: { start: outLen, end: outLen + text.length },
      src: src === null ? null : { start: src.start, end: src.end },
    });
    outLen += text.length;
    if (options.budget !== undefined && outLen > options.budget) {
      throw new BudgetExceededError(
        `Expansion budget exceeded: output would exceed ${options.budget} ` +
          `code units`,
      );
    }
  };

  let cursor = 0;
  for (const m of normalized) {
    emit(source.slice(cursor, m.start), { start: cursor, end: m.start });
    for (const token of tokens) {
      if (token.kind === "literal") {
        emit(token.text, null);
      } else {
        const cap = m.captures[token.index] as Range;
        emit(source.slice(cap.start, cap.end), cap);
      }
    }
    cursor = m.end;
  }
  emit(source.slice(cursor), { start: cursor, end: source.length });

  return {
    text: pieces.join(""),
    map: new SourceMap(segments, source.length, outLen),
  };
}
