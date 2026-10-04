import { parseTemplate } from './template';
import { SourceMap, type Segment } from './sourcemap';
import type { CaptureMatch } from './types';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface ReplaceOptions {
  /** Maximum allowed output length in code units; exceeding it aborts the operation. */
  maxOutputLength?: number;
}

export interface ReplaceResult {
  output: string;
  map: SourceMap;
}

/**
 * Expands `templates` against non-overlapping `matches` of `text` and
 * returns the new text plus a map from output ranges back to input ranges.
 *
 * The operation is atomic: every template is parsed and validated before
 * any output is produced, so an invalid capture reference or an exceeded
 * budget rejects the whole operation and no partial result escapes.
 */
export function replace(
  text: string,
  matches: CaptureMatch[],
  templates: string[],
  options: ReplaceOptions = {},
): ReplaceResult {
  if (matches.length !== templates.length) {
    throw new Error(`expected ${matches.length} templates, got ${templates.length}`);
  }
  validateMatches(text, matches);
  const parsed = matches.map((m, i) => parseTemplate(templates[i], m.captures.length));
  const budget = options.maxOutputLength ?? Number.POSITIVE_INFINITY;
  const segments: Segment[] = [];
  let output = '';
  const checkBudget = (): void => {
    if (output.length > budget) {
      throw new BudgetExceededError(
        `replacement output exceeds budget of ${budget} code units`,
      );
    }
  };
  const pushCopied = (inStart: number, inEnd: number): void => {
    if (inStart >= inEnd) return;
    const outStart = output.length;
    output += text.slice(inStart, inEnd);
    segments.push({ outStart, outEnd: output.length, inStart, inEnd });
    checkBudget();
  };
  const pushInserted = (s: string): void => {
    if (s.length === 0) return;
    output += s;
    checkBudget();
  };
  let cursor = 0;
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    pushCopied(cursor, m.start);
    for (const token of parsed[i]) {
      if (token.kind === 'literal') {
        pushInserted(token.text);
      } else if (token.index === 0) {
        pushCopied(m.start, m.end);
      } else {
        const cap = m.captures[token.index - 1];
        if (cap) pushCopied(cap.start, cap.end);
      }
    }
    cursor = m.end;
  }
  pushCopied(cursor, text.length);
  return { output, map: new SourceMap(text.length, output.length, segments) };
}

function validateMatches(text: string, matches: CaptureMatch[]): void {
  let prevEnd = 0;
  for (const m of matches) {
    if (m.start < prevEnd || m.end < m.start || m.end > text.length) {
      throw new Error('matches must be sorted, non-overlapping and inside the text');
    }
    for (const c of m.captures) {
      if (c && (c.start < m.start || c.end > m.end || c.end < c.start)) {
        throw new Error('capture interval must lie inside its match');
      }
    }
    prevEnd = m.end;
  }
}
