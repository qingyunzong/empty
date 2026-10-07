export interface Sentence {
  text: string;
  start: number;
  end: number;
}

export type UnclosedKind =
  | 'string'
  | 'template'
  | 'blockComment'
  | 'bracket';

export class SplitError extends Error {
  constructor(
    readonly kind: UnclosedKind | 'mismatch',
    readonly position: number,
    message: string,
  ) {
    super(message);
    this.name = 'SplitError';
  }
}

type Context =
  | { type: 'code'; interpolation: boolean; start: number; bracketBase: number }
  | { type: 'string'; quote: string; start: number }
  | { type: 'template'; start: number }
  | { type: 'lineComment'; start: number }
  | { type: 'blockComment'; start: number };

const OPEN_TO_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const UNCLOSED_LABEL: Record<UnclosedKind, string> = {
  string: 'string literal',
  template: 'template literal',
  blockComment: 'block comment',
  bracket: 'bracket',
};

export class Splitter {
  private buffer = '';
  private pos = 0;
  private ended = false;
  private stack: Context[] = [
    { type: 'code', interpolation: false, start: 0, bracketBase: 0 },
  ];
  private brackets: { ch: string; pos: number }[] = [];
  private sentences: Sentence[] = [];
  private sentenceStart = 0;

  write(chunk: string): this {
    if (this.ended) throw new Error('cannot write() after end()');
    this.buffer += chunk;
    this.advance();
    return this;
  }

  end(): Sentence[] {
    this.ended = true;
    this.advance();
    this.assertClosed();
    const tail = this.buffer.slice(this.sentenceStart);
    if (tail.trim().length > 0) {
      this.sentences.push({
        text: tail,
        start: this.sentenceStart,
        end: this.buffer.length,
      });
    }
    return this.sentences;
  }

  private top(): Context {
    return this.stack[this.stack.length - 1];
  }

  private advance(): void {
    const len = this.buffer.length;
    while (this.pos < len) {
      const ch = this.buffer[this.pos];
      const ctx = this.top();
      switch (ctx.type) {
        case 'string': {
          if (ch === '\\') {
            if (this.pos + 1 >= len && !this.ended) return;
            this.pos += 2;
            continue;
          }
          if (ch === ctx.quote) this.stack.pop();
          this.pos += 1;
          continue;
        }
        case 'template': {
          if (ch === '\\') {
            if (this.pos + 1 >= len && !this.ended) return;
            this.pos += 2;
            continue;
          }
          if (ch === '`') {
            this.stack.pop();
            this.pos += 1;
            continue;
          }
          if (ch === '$') {
            if (this.pos + 1 >= len && !this.ended) return;
            if (this.buffer[this.pos + 1] === '{') {
              this.stack.push({
                type: 'code',
                interpolation: true,
                start: this.pos,
                bracketBase: this.brackets.length,
              });
              this.pos += 2;
              continue;
            }
          }
          this.pos += 1;
          continue;
        }
        case 'lineComment': {
          if (ch === '\n') this.stack.pop();
          this.pos += 1;
          continue;
        }
        case 'blockComment': {
          if (ch === '*') {
            if (this.pos + 1 >= len && !this.ended) return;
            if (this.buffer[this.pos + 1] === '/') {
              this.stack.pop();
              this.pos += 2;
              continue;
            }
          }
          this.pos += 1;
          continue;
        }
        case 'code': {
          if (ch === '/') {
            if (this.pos + 1 >= len && !this.ended) return;
            const next = this.buffer[this.pos + 1];
            if (next === '/') {
              this.stack.push({ type: 'lineComment', start: this.pos });
              this.pos += 2;
              continue;
            }
            if (next === '*') {
              this.stack.push({ type: 'blockComment', start: this.pos });
              this.pos += 2;
              continue;
            }
            this.pos += 1;
            continue;
          }
          if (ch === "'" || ch === '"') {
            this.stack.push({ type: 'string', quote: ch, start: this.pos });
            this.pos += 1;
            continue;
          }
          if (ch === '`') {
            this.stack.push({ type: 'template', start: this.pos });
            this.pos += 1;
            continue;
          }
          if (ch in OPEN_TO_CLOSE) {
            this.brackets.push({ ch, pos: this.pos });
            this.pos += 1;
            continue;
          }
          if (ch in CLOSE_TO_OPEN) {
            if (this.brackets.length > ctx.bracketBase) {
              const open = this.brackets[this.brackets.length - 1];
              if (OPEN_TO_CLOSE[open.ch] !== ch) {
                throw new SplitError(
                  'mismatch',
                  this.pos,
                  `mismatched '${ch}' at ${this.pos}: closes '${open.ch}' opened at ${open.pos}`,
                );
              }
              this.brackets.pop();
              this.pos += 1;
              continue;
            }
            if (ch === '}' && ctx.interpolation) {
              this.stack.pop();
              this.pos += 1;
              continue;
            }
            throw new SplitError(
              'mismatch',
              this.pos,
              `unmatched '${ch}' at ${this.pos}`,
            );
          }
          if (
            ch === ';' &&
            this.stack.length === 1 &&
            this.brackets.length === 0
          ) {
            this.sentences.push({
              text: this.buffer.slice(this.sentenceStart, this.pos + 1),
              start: this.sentenceStart,
              end: this.pos + 1,
            });
            this.sentenceStart = this.pos + 1;
          }
          this.pos += 1;
          continue;
        }
      }
    }
  }

  private assertClosed(): void {
    let kind: UnclosedKind | null = null;
    let position = Infinity;
    for (const ctx of this.stack.slice(1)) {
      if (ctx.type === 'lineComment') continue;
      if (ctx.type !== 'code' && ctx.start < position) {
        position = ctx.start;
        kind = ctx.type;
      }
    }
    for (const b of this.brackets) {
      if (b.pos < position) {
        position = b.pos;
        kind = 'bracket';
      }
    }
    if (kind !== null) {
      throw new SplitError(
        kind,
        position,
        `unclosed ${UNCLOSED_LABEL[kind]} opened at ${position}`,
      );
    }
  }
}

export function split(source: string): Sentence[] {
  const splitter = new Splitter();
  splitter.write(source);
  return splitter.end();
}
