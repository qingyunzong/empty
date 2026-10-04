import type { CaptureMatch } from './types';

/**
 * Deliberately naive, segment-by-segment interpreter used as an independent
 * cross-check for `replace()`. It walks the matches in order, splices the
 * gaps, and expands each template character by character without building
 * any mapping.
 */
export function interpret(text: string, matches: CaptureMatch[], templates: string[]): string {
  let out = '';
  let cursor = 0;
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    out += text.slice(cursor, m.start);
    out += expandTemplate(text, m, templates[i]);
    cursor = m.end;
  }
  out += text.slice(cursor);
  return out;
}

function expandTemplate(text: string, m: CaptureMatch, template: string): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }
    const next: string | undefined = template[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (next === '&') {
      out += text.slice(m.start, m.end);
      i += 2;
      continue;
    }
    if (next !== undefined && next >= '0' && next <= '9') {
      let idx = next.charCodeAt(0) - 48;
      let consumed = 2;
      const third: string | undefined = template[i + 2];
      if (third !== undefined && third >= '0' && third <= '9') {
        const two = idx * 10 + (third.charCodeAt(0) - 48);
        if (two >= 1 && two <= m.captures.length) {
          idx = two;
          consumed = 3;
        }
      }
      if (idx < 1 || idx > m.captures.length) {
        throw new Error(`invalid capture reference $${idx}`);
      }
      const cap = m.captures[idx - 1];
      if (cap) out += text.slice(cap.start, cap.end);
      i += consumed;
      continue;
    }
    out += '$';
    i += 1;
  }
  return out;
}
