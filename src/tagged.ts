import { parseTemplate } from './template';
import type { CaptureMatch } from './types';

/**
 * Source-label propagation model used by the randomized tests: every output
 * code unit carries the index of the input code unit it was copied from, or
 * `null` when it was inserted. This is an oracle independent of SourceMap.
 */
export interface TaggedChar {
  ch: string;
  src: number | null;
}

export function tagText(text: string): TaggedChar[] {
  const out: TaggedChar[] = [];
  for (let i = 0; i < text.length; i += 1) {
    out.push({ ch: text[i], src: i });
  }
  return out;
}

export function untag(chars: TaggedChar[]): string {
  return chars.map((c) => c.ch).join('');
}

export function taggedReplace(
  text: TaggedChar[],
  matches: CaptureMatch[],
  templates: string[],
): TaggedChar[] {
  const out: TaggedChar[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    out.push(...text.slice(cursor, m.start));
    for (const token of parseTemplate(templates[i], m.captures.length)) {
      if (token.kind === 'literal') {
        for (let j = 0; j < token.text.length; j += 1) {
          out.push({ ch: token.text[j], src: null });
        }
      } else {
        const range =
          token.index === 0 ? { start: m.start, end: m.end } : m.captures[token.index - 1];
        if (range) out.push(...text.slice(range.start, range.end));
      }
    }
    cursor = m.end;
  }
  out.push(...text.slice(cursor));
  return out;
}
