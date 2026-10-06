/**
 * Split a script into statements on top-level semicolons.
 *
 * Semicolons inside the following constructs do NOT split:
 *  - single-quoted / double-quoted strings (with '' / "" doubling and \ escapes)
 *  - line comments (-- ... and // ... up to newline)
 *  - block comments (slash-star ... star-slash)
 *  - template literals (`...`), including ${ ... } interpolations which may
 *    contain nested braces, parentheses, strings, comments and templates.
 *
 * Every returned statement keeps its original source span (start/end offsets).
 * Unterminated constructs raise UnclosedConstructError pointing at the
 * opening position of the innermost unclosed construct.
 */

export interface SourcePosition {
  /** 0-based character offset into the source. */
  index: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

export type UnclosedKind =
  | "string"
  | "blockComment"
  | "template"
  | "interpolation";

export class UnclosedConstructError extends SyntaxError {
  readonly kind: UnclosedKind;
  readonly position: SourcePosition;

  constructor(kind: UnclosedKind, position: SourcePosition) {
    super(
      `Unclosed ${kind} starting at line ${position.line}, column ${position.column} (offset ${position.index})`,
    );
    this.name = "UnclosedConstructError";
    this.kind = kind;
    this.position = position;
  }
}

export interface Statement {
  /** Exact source text of the statement, including the terminating ';' if present. */
  text: string;
  /** 0-based inclusive start offset in the source. */
  start: number;
  /** 0-based exclusive end offset in the source. */
  end: number;
}

type Frame =
  | { type: "normal" }
  | { type: "string"; quote: string; openIndex: number }
  | { type: "lineComment" }
  | { type: "blockComment"; openIndex: number }
  | { type: "template"; openIndex: number }
  | { type: "interpolation"; braceDepth: number; openIndex: number };

const FRAME_KIND: Record<Exclude<Frame["type"], "normal" | "lineComment">, UnclosedKind> = {
  string: "string",
  blockComment: "blockComment",
  template: "template",
  interpolation: "interpolation",
};

/**
 * Incremental, chunk-safe script splitter. Feed arbitrary chunks via
 * write(), then call end() to obtain the statements. Feeding the whole
 * script at once or one character at a time yields identical results.
 */
export class StatementSplitter {
  private buffer = "";
  private stack: Frame[] = [{ type: "normal" }];
  private statements: Statement[] = [];
  private statementStart = 0;
  private finished = false;
  /** Next index in buffer that still needs to be processed. */
  private processed = 0;
  /** Highest index already consumed (escaped/paired character). */
  private consumed = -1;

  write(chunk: string): void {
    if (this.finished) {
      throw new Error("StatementSplitter: write() after end()");
    }
    this.buffer += chunk;
    this.processAvailable(false);
  }

  end(): Statement[] {
    if (this.finished) {
      return this.statements.slice();
    }
    this.finished = true;
    this.processAvailable(true);
    const top = this.stack[this.stack.length - 1];
    if (top.type !== "normal" && top.type !== "lineComment") {
      const openIndex = (top as { openIndex: number }).openIndex;
      throw new UnclosedConstructError(
        FRAME_KIND[top.type as keyof typeof FRAME_KIND],
        this.positionAt(openIndex),
      );
    }
    this.flushStatement(this.buffer.length);
    return this.statements.slice();
  }

  /**
   * Process buffered characters. When not final, the last character is
   * deferred if interpreting it requires looking at the next character
   * (e.g. "--", "/*", "${", doubled quotes, backslash escapes), because a
   * future chunk may supply that next character.
   */
  private processAvailable(final: boolean): void {
    let i = this.processed;
    for (; i < this.buffer.length; i++) {
      if (i <= this.consumed) {
        continue;
      }
      if (!final && i === this.buffer.length - 1 && this.needsLookahead(i)) {
        break;
      }
      this.step(i);
    }
    this.processed = i;
  }

  private needsLookahead(i: number): boolean {
    const ch = this.buffer[i];
    const top = this.stack[this.stack.length - 1];
    switch (top.type) {
      case "string":
        return ch === "\\" || ch === top.quote;
      case "template":
        return ch === "\\" || ch === "$";
      case "blockComment":
        return ch === "*";
      case "lineComment":
        return false;
      case "normal":
      case "interpolation":
        return ch === "-" || ch === "/";
    }
  }

  private positionAt(index: number): SourcePosition {
    let line = 1;
    let column = 1;
    for (let i = 0; i < index; i++) {
      if (this.buffer.charCodeAt(i) === 10) {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return { index, line, column };
  }

  private flushStatement(end: number): void {
    const text = this.buffer.slice(this.statementStart, end);
    // Ignore the terminating ';' (if any) when deciding whether the
    // statement is empty.
    const content = text.endsWith(";") ? text.slice(0, -1) : text;
    if (content.trim().length > 0) {
      this.statements.push({ text, start: this.statementStart, end });
    }
    this.statementStart = end;
  }

  private step(i: number): void {
    const ch = this.buffer[i];
    const next = i + 1 < this.buffer.length ? this.buffer[i + 1] : "";
    const top = this.stack[this.stack.length - 1];

    switch (top.type) {
      case "normal":
      case "interpolation":
        this.stepCode(i, ch, next, top);
        return;
      case "string":
        if (ch === "\\") {
          // Consume the escaped character on the next iteration by skipping
          // it here: mark it consumed via a lookahead skip.
          this.skipTo(i + 1);
        } else if (ch === top.quote) {
          if (next === top.quote) {
            // Doubled quote escape ('' or "").
            this.skipTo(i + 1);
          } else {
            this.stack.pop();
          }
        }
        return;
      case "lineComment":
        if (ch === "\n") {
          this.stack.pop();
        }
        return;
      case "blockComment":
        if (ch === "*" && next === "/") {
          this.stack.pop();
          this.skipTo(i + 1);
        }
        return;
      case "template":
        if (ch === "\\") {
          this.skipTo(i + 1);
        } else if (ch === "`") {
          this.stack.pop();
        } else if (ch === "$" && next === "{") {
          this.stack.push({ type: "interpolation", braceDepth: 0, openIndex: i });
          this.skipTo(i + 1);
        }
        return;
    }
  }

  private skipTo(index: number): void {
    this.consumed = Math.max(this.consumed, index);
  }

  private stepCode(i: number, ch: string, next: string, top: Frame): void {
    if (top.type === "interpolation") {
      if (ch === "{") {
        top.braceDepth++;
        return;
      }
      if (ch === "}") {
        if (top.braceDepth === 0) {
          this.stack.pop();
        } else {
          top.braceDepth--;
        }
        return;
      }
    }
    switch (ch) {
      case ";":
        if (top.type === "normal") {
          this.flushStatement(i + 1);
        }
        return;
      case "'":
      case '"':
        this.stack.push({ type: "string", quote: ch, openIndex: i });
        return;
      case "`":
        this.stack.push({ type: "template", openIndex: i });
        return;
      case "-":
        if (next === "-") {
          this.stack.push({ type: "lineComment" });
          this.skipTo(i + 1);
        }
        return;
      case "/":
        if (next === "/") {
          this.stack.push({ type: "lineComment" });
          this.skipTo(i + 1);
        } else if (next === "*") {
          this.stack.push({ type: "blockComment", openIndex: i });
          this.skipTo(i + 1);
        }
        return;
    }
  }
}

/** Split a whole script string into statements in one pass. */
export function splitStatements(script: string): Statement[] {
  const splitter = new StatementSplitter();
  splitter.write(script);
  return splitter.end();
}

/**
 * Split a script by feeding it to the splitter in consecutive chunks.
 * chunkSizes[i] is the length of the i-th chunk; the last chunk takes the
 * remainder. Useful to verify chunked parsing matches whole-string parsing.
 */
export function splitStatementsChunked(
  script: string,
  chunkSizes: readonly number[],
): Statement[] {
  const splitter = new StatementSplitter();
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= script.length) {
      break;
    }
    splitter.write(script.slice(offset, offset + size));
    offset += size;
  }
  if (offset < script.length) {
    splitter.write(script.slice(offset));
  }
  return splitter.end();
}
