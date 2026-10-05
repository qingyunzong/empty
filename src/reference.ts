import type { MatchInfo, Range } from "./types.js";
import { InvalidCaptureError } from "./errors.js";

/**
 * A text where every code unit carries the index of the original source
 * code unit it stems from, or -1 when it was inserted by a template.
 */
export interface LabelledText {
  text: string;
  labels: number[];
}

export function labelSource(source: string): LabelledText {
  const labels: number[] = [];
  for (let i = 0; i < source.length; i++) labels.push(i);
  return { text: source, labels };
}

function capturesOf(m: MatchInfo): Array<Range | undefined> {
  const caps: Array<Range | undefined> = (m.captures ?? []).slice();
  if (caps[0] === undefined) caps[0] = { start: m.start, end: m.end };
  return caps;
}

/**
 * Naive piecewise interpreter used as the cross-checking oracle for the
 * optimized implementation. It walks the input piece by piece, expands
 * `$` references literally, and propagates one source label per code unit.
 */
export function referenceReplace(
  input: LabelledText,
  matches: MatchInfo[],
  template: string,
): LabelledText {
  let text = "";
  const labels: number[] = [];

  const emitLiteral = (s: string): void => {
    text += s;
    for (let k = 0; k < s.length; k++) labels.push(-1);
  };
  const emitSlice = (a: number, b: number): void => {
    text += input.text.slice(a, b);
    for (let k = a; k < b; k++) labels.push(input.labels[k]);
  };

  let cursor = 0;
  for (const m of matches) {
    emitSlice(cursor, m.start);
    const caps = capturesOf(m);
    let i = 0;
    while (i < template.length) {
      const ch = template[i];
      if (ch !== "$") {
        emitLiteral(ch);
        i += 1;
        continue;
      }
      const next = i + 1 < template.length ? template[i + 1] : undefined;
      if (next === "$") {
        emitLiteral("$");
        i += 2;
        continue;
      }
      if (next === "&") {
        const whole = caps[0] as Range;
        emitSlice(whole.start, whole.end);
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
        const cap = caps[index];
        if (cap === undefined) {
          throw new InvalidCaptureError(
            `reference: invalid capture $${index}`,
          );
        }
        emitSlice(cap.start, cap.end);
        i += consumed;
        continue;
      }
      throw new InvalidCaptureError(
        `reference: malformed dollar reference at ${i}`,
      );
    }
    cursor = m.end;
  }
  emitSlice(cursor, input.text.length);
  return { text, labels };
}
