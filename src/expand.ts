/**
 * Response-file expansion with per-byte provenance.
 *
 * A response file is a display string (same quoting rules as quote.ts) that
 * may additionally contain directives. A directive is only recognized at a
 * token boundary (start of file or directly after a blank) and must be
 * blank-terminated:
 *
 *   @path/to/file.rsp   splice the expanded contents of another response file
 *   @if(name)           begin a conditional branch, taken when `name` is in
 *                       the condition set; `@if(!name)` negates
 *   @else               switch the innermost conditional branch
 *   @endif              close the innermost conditional branch
 *
 * A literal `@` at a token boundary can be produced by quoting ('@') or
 * backslash-escaping (\@). `@` anywhere else in a token is always literal.
 * Conditional directives inside a skipped branch are still recognized so
 * that nesting stays balanced, but quoted tokens remain quoted there too.
 *
 * Expansion is pure byte substitution: every byte of the resulting display
 * string originates from a byte of some file, recorded as a Segment. This
 * provenance is what makes reverse editing (edit.ts) possible.
 */

import { assertNoNul } from "./quote.js";

/** A run of output bytes mapped 1:1 to a run of source bytes. */
export interface Segment {
  /** Offset of this run in the expanded display string. */
  outStart: number;
  /** Source file path in the virtual file system. */
  file: string;
  /** Start offset in the source file. */
  start: number;
  /** End offset (exclusive) in the source file. */
  end: number;
}

export interface Expanded {
  /** The expanded display string. */
  text: string;
  /** Contiguous, ordered provenance segments covering `text`. */
  segments: Segment[];
}

function isBlank(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

const IF_RE = /^@if\((!?)([A-Za-z0-9_.-]+)\)$/;

interface CondFrame {
  parentActive: boolean;
  conditionTrue: boolean;
  elseSeen: boolean;
}

class Expander {
  private chunks: string[] = [];
  private segments: Segment[] = [];
  private outLen = 0;

  constructor(
    private readonly vfs: ReadonlyMap<string, string>,
    private readonly conds: ReadonlySet<string>,
  ) {}

  private emit(file: string, start: number, end: number): void {
    if (end <= start) return;
    const content = this.vfs.get(file);
    if (content === undefined) {
      throw new Error(`internal error: emitting from unknown file ${file}`);
    }
    this.chunks.push(content.slice(start, end));
    const last = this.segments[this.segments.length - 1];
    if (last && last.file === file && last.end === start) {
      last.end = end;
    } else {
      this.segments.push({ outStart: this.outLen, file, start, end });
    }
    this.outLen += end - start;
  }

  expand(mainFile: string): Expanded {
    this.expandFile(mainFile, []);
    return { text: this.chunks.join(""), segments: this.segments };
  }

  private expandFile(file: string, stack: string[]): void {
    const content = this.vfs.get(file);
    if (content === undefined) {
      const via = stack.length > 0 ? ` (included from ${stack[stack.length - 1]})` : "";
      throw new Error(`response file not found: ${file}${via}`);
    }
    assertNoNul(content, `response file ${file}`);
    if (stack.includes(file)) {
      throw new Error(`response file cycle: ${[...stack, file].join(" -> ")}`);
    }
    const nextStack = [...stack, file];
    const n = content.length;
    const condStack: CondFrame[] = [];
    const isActive = (): boolean => {
      for (const f of condStack) {
        const on = f.elseSeen ? !f.conditionTrue : f.conditionTrue;
        if (!(f.parentActive && on)) return false;
      }
      return true;
    };

    let litStart = 0; // start of the pending literal run
    let i = 0;
    const flushLiteral = (upto: number): void => {
      if (isActive()) this.emit(file, litStart, upto);
    };

    while (i < n) {
      const atTokenStart = i === 0 || isBlank(content[i - 1]!);
      if (atTokenStart && content[i] === "@" && i + 1 < n && !isBlank(content[i + 1]!)) {
        // Read the raw directive token (up to the next blank).
        let tokEnd = i + 1;
        while (tokEnd < n && !isBlank(content[tokEnd]!)) tokEnd++;
        const token = content.slice(i, tokEnd);
        const ifMatch = IF_RE.exec(token);
        const isDirective =
          ifMatch !== null || token === "@else" || token === "@endif";
        if (isDirective) {
          flushLiteral(i);
          if (ifMatch) {
            const negated = ifMatch[1] === "!";
            const name = ifMatch[2]!;
            let cond = this.conds.has(name);
            if (negated) cond = !cond;
            condStack.push({
              parentActive: isActive(),
              conditionTrue: cond,
              elseSeen: false,
            });
          } else if (token === "@else") {
            const frame = condStack[condStack.length - 1];
            if (!frame) throw new Error(`@else without @if in ${file} at offset ${i}`);
            if (frame.elseSeen) throw new Error(`duplicate @else in ${file} at offset ${i}`);
            frame.elseSeen = true;
          } else {
            if (condStack.pop() === undefined) {
              throw new Error(`@endif without @if in ${file} at offset ${i}`);
            }
          }
          i = tokEnd;
          litStart = tokEnd;
          continue;
        }
        if (isActive()) {
          // @path include: splice the expanded file in place of the token.
          flushLiteral(i);
          this.expandFile(token.slice(1), nextStack);
          i = tokEnd;
          litStart = tokEnd;
          continue;
        }
        // Inactive branch: drop the include token without resolving it.
        i = tokEnd;
        litStart = tokEnd;
        continue;
      }
      // Blanks stay inside the pending literal run; just skip past them.
      if (isBlank(content[i]!)) {
        i++;
        continue;
      }
      // Literal token: consume it, honoring quoting so that blanks and @
      // inside quotes do not act as token boundaries / directives.
      let j = i;
      while (j < n && !isBlank(content[j]!)) {
        const ch = content[j]!;
        if (ch === "'") {
          const close = content.indexOf("'", j + 1);
          j = close < 0 ? n : close + 1;
        } else if (ch === '"') {
          j++;
          while (j < n && content[j] !== '"') {
            j += content[j] === "\\" ? 2 : 1;
          }
          if (j < n) j++;
        } else if (ch === "\\") {
          j = Math.min(j + 2, n);
        } else {
          j++;
        }
      }
      i = j;
    }
    flushLiteral(n);
    if (condStack.length > 0) {
      throw new Error(`unterminated @if in ${file}`);
    }
  }
}

/**
 * Expand `mainFile` from the virtual file system into a display string with
 * full per-byte provenance. `conds` is the set of enabled condition names
 * for `@if(...)` branches.
 */
export function expand(
  mainFile: string,
  vfs: ReadonlyMap<string, string>,
  conds: ReadonlySet<string> = new Set(),
): Expanded {
  return new Expander(vfs, conds).expand(mainFile);
}

/**
 * Return the provenance segments intersecting the output range
 * [start, end). The result always fully covers the range.
 */
export function segmentsForRange(
  exp: Expanded,
  start: number,
  end: number,
): Segment[] {
  const out: Segment[] = [];
  for (const seg of exp.segments) {
    const segEnd = seg.outStart + (seg.end - seg.start);
    if (segEnd <= start) continue;
    if (seg.outStart >= end) break;
    out.push(seg);
  }
  return out;
}

/** A byte range in a source file. */
export interface SourceSpan {
  file: string;
  start: number;
  end: number;
}

/**
 * Map an output range [start, end) to exact source byte spans, clipping
 * provenance segments to the range. The concatenation of the corresponding
 * source bytes equals exp.text.slice(start, end).
 */
export function sourceSpans(exp: Expanded, start: number, end: number): SourceSpan[] {
  return segmentsForRange(exp, start, end).map((seg) => {
    const segOutEnd = seg.outStart + (seg.end - seg.start);
    const clipStart = Math.max(start, seg.outStart);
    const clipEnd = Math.min(end, segOutEnd);
    return {
      file: seg.file,
      start: seg.start + (clipStart - seg.outStart),
      end: seg.start + (clipEnd - seg.outStart),
    };
  });
}

/** The source bytes a segment refers to. */
export function segmentText(vfs: ReadonlyMap<string, string>, seg: Segment): string {
  const content = vfs.get(seg.file);
  if (content === undefined) {
    throw new Error(`unknown file ${seg.file}`);
  }
  return content.slice(seg.start, seg.end);
}
