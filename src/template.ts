import { InvalidCaptureError } from "./errors.js";

export type TemplateToken =
  | { kind: "literal"; text: string }
  | { kind: "capture"; index: number };

/**
 * Parses a replacement template into literal and capture-reference tokens.
 *
 * Supported forms:
 *   `$$`  -> a literal dollar sign
 *   `$&`  -> the whole match (same as `$0`)
 *   `$n` / `$nn` -> capture group n (up to two digits, greedy)
 *
 * Any other use of `$` (e.g. `$x`, trailing `$`) is malformed and throws
 * InvalidCaptureError, so the caller can reject the whole operation.
 */
export function parseTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let literal = "";
  const flushLiteral = (): void => {
    if (literal.length > 0) {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== "$") {
      literal += ch;
      i += 1;
      continue;
    }
    const next = i + 1 < template.length ? template[i + 1] : undefined;
    if (next === "$") {
      literal += "$";
      i += 2;
      continue;
    }
    if (next === "&") {
      flushLiteral();
      tokens.push({ kind: "capture", index: 0 });
      i += 2;
      continue;
    }
    if (next !== undefined && next >= "0" && next <= "9") {
      let index = next.charCodeAt(0) - 48;
      let consumed = 2;
      const third = i + 2 < template.length ? template[i + 2] : undefined;
      if (third !== undefined && third >= "0" && third <= "9") {
        index = index * 10 + (third.charCodeAt(0) - 48);
        consumed = 3;
      }
      flushLiteral();
      tokens.push({ kind: "capture", index });
      i += consumed;
      continue;
    }
    throw new InvalidCaptureError(
      `Malformed dollar reference at template index ${i}`,
    );
  }
  flushLiteral();
  return tokens;
}
