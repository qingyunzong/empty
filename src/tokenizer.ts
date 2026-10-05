import type { Diagnostic, ParserEvent, Segment } from './types.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** 实体向前看的最大字符数，超过即按字面文本处理。 */
const MAX_ENTITY_LENGTH = 32;

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isEntityCandidateChar(ch: string): boolean {
  return isAsciiLetter(ch) || (ch >= '0' && ch <= '9') || ch === '#';
}

/** 解码实体主体（不含 & 与 ;），无法解码时返回 null。 */
export function decodeEntity(body: string): string | null {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const digits = hex ? body.slice(2) : body.slice(1);
    if (digits.length === 0) return null;
    const cp = parseInt(digits, hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return null;
    }
    return String.fromCodePoint(cp);
  }
  return NAMED_ENTITIES[body] ?? null;
}

/**
 * 增量词法器：把任意切分的字符串块转换为确定的事件流。
 * 文本事件是“极大”的——只在标签边界或输入结束时产出，
 * 因此事件流与分块方式无关。
 */
export class Tokenizer {
  private buffer = '';
  /** buffer[0] 在完整输入中的绝对偏移。 */
  private base = 0;
  private segments: Segment[] = [];
  private text = '';

  constructor(
    private readonly emit: (event: ParserEvent) => void,
    private readonly report: (diagnostic: Diagnostic) => void,
  ) {}

  /** 已消费的输入长度。 */
  get position(): number {
    return this.base;
  }

  write(chunk: string): void {
    if (chunk.length === 0) return;
    this.buffer += chunk;
    this.pump(false);
  }

  end(): void {
    this.pump(true);
    this.flushText();
  }

  private consume(count: number): void {
    this.buffer = this.buffer.slice(count);
    this.base += count;
  }

  private appendText(text: string, start: number, end: number): void {
    if (text.length === 0) return;
    this.segments.push({ text, start, end });
    this.text += text;
  }

  private flushText(): void {
    if (this.segments.length === 0) return;
    const start = this.segments[0]!.start;
    const end = this.segments[this.segments.length - 1]!.end;
    this.emit({ type: 'text', text: this.text, segments: this.segments, start, end });
    this.segments = [];
    this.text = '';
  }

  private pump(final: boolean): void {
    for (;;) {
      if (this.buffer.length === 0) return;
      const ch = this.buffer[0]!;
      let progressed: boolean;
      if (ch === '<') progressed = this.tryTag(final);
      else if (ch === '&') progressed = this.tryEntity(final);
      else progressed = this.tryText(final);
      if (!progressed) return; // 需要更多输入
    }
  }

  private tryText(final: boolean): boolean {
    const buf = this.buffer;
    let i = 0;
    while (i < buf.length && buf[i] !== '<' && buf[i] !== '&') i++;
    if (i === buf.length && !final) return false; // 文本可能延续到下一个块
    if (i === 0) return false;
    this.appendText(buf.slice(0, i), this.base, this.base + i);
    this.consume(i);
    return true;
  }

  private tryTag(final: boolean): boolean {
    const buf = this.buffer;
    if (buf.length < 2) {
      if (!final) return false;
      this.appendText('<', this.base, this.base + 1);
      this.consume(1);
      return true;
    }
    const second = buf[1]!;
    if (second !== '/' && !isAsciiLetter(second)) {
      // '<' 后不是标签起始，按字面文本处理
      this.appendText('<', this.base, this.base + 1);
      this.consume(1);
      return true;
    }
    const gt = buf.indexOf('>');
    if (gt === -1) {
      if (!final) return false;
      this.report({
        code: 'malformed-tag',
        message: 'Unterminated tag at end of input',
        start: this.base,
        end: this.base + buf.length,
      });
      this.appendText(buf, this.base, this.base + buf.length);
      this.consume(buf.length);
      return true;
    }
    const raw = buf.slice(0, gt + 1);
    const start = this.base;
    const end = start + raw.length;
    if (second === '/') {
      const m = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(raw);
      if (!m) {
        this.report({
          code: 'malformed-tag',
          message: `Malformed closing tag ${raw}`,
          start,
          end,
        });
        this.consume(raw.length);
        return true;
      }
      this.flushText();
      this.emit({ type: 'close', name: m[1]!.toLowerCase(), raw, start, end });
      this.consume(raw.length);
      return true;
    }
    const m = /^<([A-Za-z][A-Za-z0-9]*)/.exec(raw)!;
    const selfClosing = /\/\s*>$/.test(raw);
    this.flushText();
    this.emit({ type: 'open', name: m[1]!.toLowerCase(), selfClosing, raw, start, end });
    this.consume(raw.length);
    return true;
  }

  private tryEntity(final: boolean): boolean {
    const buf = this.buffer;
    const full = /^&(#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.exec(buf);
    if (full) {
      const raw = full[0];
      const decoded = decodeEntity(full[1]!);
      if (decoded === null) {
        this.report({
          code: 'unknown-entity',
          message: `Unknown entity ${raw}`,
          start: this.base,
          end: this.base + raw.length,
        });
        this.appendText(raw, this.base, this.base + raw.length);
      } else {
        this.appendText(decoded, this.base, this.base + raw.length);
      }
      this.consume(raw.length);
      return true;
    }
    // 扫描 & 之后的候选实体字符
    let j = 1;
    while (j < buf.length && isEntityCandidateChar(buf[j]!)) j++;
    if (j === buf.length) {
      // 整个缓冲都可能是实体的前缀，等待更多输入
      if (!final && buf.length < MAX_ENTITY_LENGTH) return false;
      this.appendText('&', this.base, this.base + 1);
      this.consume(1);
      return true;
    }
    if (buf[j] === ';' && j > 1) {
      // 形如 &...; 但不是合法实体
      const raw = buf.slice(0, j + 1);
      this.report({
        code: 'unknown-entity',
        message: `Invalid entity ${raw}`,
        start: this.base,
        end: this.base + raw.length,
      });
      this.appendText(raw, this.base, this.base + raw.length);
      this.consume(raw.length);
      return true;
    }
    // 裸露的 '&'
    this.appendText('&', this.base, this.base + 1);
    this.consume(1);
    return true;
  }
}
