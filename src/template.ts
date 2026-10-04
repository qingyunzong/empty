export type TemplateToken =
  | { kind: 'literal'; text: string }
  | { kind: 'capture'; index: number }; // 0 = whole match ($&), 1..n = group $n

export class InvalidReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReferenceError';
  }
}

const isDigit = (ch: string | undefined): ch is string =>
  ch !== undefined && ch >= '0' && ch <= '9';

/**
 * Parses a replacement template into tokens.
 *
 * Supported syntax: `$$` (literal dollar), `$&` (whole match), `$1`..`$99`
 * (capture groups; two digits are preferred when they form a valid group
 * number). A `$` followed by anything else is a literal `$`.
 *
 * A `$n` reference to a group that does not exist for the match is invalid
 * and throws {@link InvalidReferenceError}; callers parse every template
 * before emitting any output so the whole operation is rejected atomically.
 */
export function parseTemplate(template: string, groupCount: number): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let literal = '';
  const flushLiteral = (): void => {
    if (literal.length > 0) {
      tokens.push({ kind: 'literal', text: literal });
      literal = '';
    }
  };
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '$') {
      literal += ch;
      i += 1;
      continue;
    }
    const next: string | undefined = template[i + 1];
    if (next === undefined) {
      literal += '$';
      i += 1;
      continue;
    }
    if (next === '$') {
      literal += '$';
      i += 2;
      continue;
    }
    if (next === '&') {
      flushLiteral();
      tokens.push({ kind: 'capture', index: 0 });
      i += 2;
      continue;
    }
    if (isDigit(next)) {
      const d1 = next.charCodeAt(0) - 48;
      const after: string | undefined = template[i + 2];
      const d2 = isDigit(after) ? after.charCodeAt(0) - 48 : -1;
      if (d2 >= 0) {
        const two = d1 * 10 + d2;
        if (two >= 1 && two <= groupCount) {
          flushLiteral();
          tokens.push({ kind: 'capture', index: two });
          i += 3;
          continue;
        }
      }
      if (d1 >= 1 && d1 <= groupCount) {
        flushLiteral();
        tokens.push({ kind: 'capture', index: d1 });
        i += 2;
        continue;
      }
      const shown = d2 >= 0 ? `$${d1}${d2}` : `$${d1}`;
      throw new InvalidReferenceError(
        `invalid capture reference ${shown}: match has ${groupCount} group(s)`,
      );
    }
    literal += '$';
    i += 1;
  }
  flushLiteral();
  return tokens;
}
