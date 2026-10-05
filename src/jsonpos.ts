// 带位置信息的 JSON 解析器：为每个值记录 JSON 指针 -> 行列范围（引用范围）
export interface Pos {
  line: number;
  col: number;
  offset: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonDocument {
  name: string;
  text: string;
  value: JsonValue;
  ranges: Map<string, Range>;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

class Parser {
  private i = 0;
  private line = 1;
  private col = 1;

  constructor(
    private readonly text: string,
    private readonly ranges: Map<string, Range>,
    private readonly docName: string,
  ) {}

  private pos(): Pos {
    return { line: this.line, col: this.col, offset: this.i };
  }

  private advance(): string {
    const ch = this.text[this.i] as string;
    this.i += 1;
    if (ch === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return ch;
  }

  private fail(message: string): never {
    throw new Error(`${this.docName}: JSON 解析失败 (行 ${this.line}:${this.col}): ${message}`);
  }

  private skipWs(): void {
    while (this.i < this.text.length) {
      const ch = this.text[this.i] as string;
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') this.advance();
      else break;
    }
  }

  private expect(word: string): void {
    for (const ch of word) {
      if (this.i >= this.text.length || this.text[this.i] !== ch) this.fail(`期望 "${word}"`);
      this.advance();
    }
  }

  parse(): JsonValue {
    this.skipWs();
    const value = this.parseValue('');
    this.skipWs();
    if (this.i !== this.text.length) this.fail('文档末尾存在多余内容');
    return value;
  }

  private parseValue(pointer: string): JsonValue {
    this.skipWs();
    if (this.i >= this.text.length) this.fail('意外结束');
    const start = this.pos();
    const ch = this.text[this.i] as string;
    let value: JsonValue;
    if (ch === '{') value = this.parseObject(pointer);
    else if (ch === '[') value = this.parseArray(pointer);
    else if (ch === '"') value = this.parseString();
    else if (ch === 't') { this.expect('true'); value = true; }
    else if (ch === 'f') { this.expect('false'); value = false; }
    else if (ch === 'n') { this.expect('null'); value = null; }
    else value = this.parseNumber();
    this.ranges.set(pointer, { start, end: this.pos() });
    return value;
  }

  private parseObject(pointer: string): JsonValue {
    const obj: { [key: string]: JsonValue } = {};
    this.advance(); // {
    this.skipWs();
    if (this.text[this.i] === '}') { this.advance(); return obj; }
    for (;;) {
      this.skipWs();
      if (this.text[this.i] !== '"') this.fail('对象键必须是字符串');
      const key = this.parseString();
      this.skipWs();
      if (this.text[this.i] !== ':') this.fail('对象键后期望 ":"');
      this.advance();
      const childPointer = `${pointer}/${escapePointerSegment(key)}`;
      obj[key] = this.parseValue(childPointer);
      this.skipWs();
      const ch = this.advance();
      if (ch === '}') break;
      if (ch !== ',') this.fail('对象中期望 "," 或 "}"');
    }
    return obj;
  }

  private parseArray(pointer: string): JsonValue {
    const arr: JsonValue[] = [];
    this.advance(); // [
    this.skipWs();
    if (this.text[this.i] === ']') { this.advance(); return arr; }
    for (;;) {
      const childPointer = `${pointer}/${arr.length}`;
      arr.push(this.parseValue(childPointer));
      this.skipWs();
      const ch = this.advance();
      if (ch === ']') break;
      if (ch !== ',') this.fail('数组中期望 "," 或 "]"');
    }
    return arr;
  }

  private parseString(): string {
    this.advance(); // 开引号
    let out = '';
    for (;;) {
      if (this.i >= this.text.length) this.fail('字符串未闭合');
      const ch = this.advance();
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.advance();
        switch (esc) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            let hex = '';
            for (let k = 0; k < 4; k++) hex += this.advance();
            const code = Number.parseInt(hex, 16);
            if (Number.isNaN(code)) this.fail('非法 \\u 转义');
            out += String.fromCharCode(code);
            break;
          }
          default: this.fail(`非法转义 "\\${esc}"`);
        }
      } else {
        out += ch;
      }
    }
  }

  private parseNumber(): number {
    const rest = this.text.slice(this.i);
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (!m) this.fail('非法数值');
    for (let k = 0; k < m[0].length; k++) this.advance();
    return Number(m[0]);
  }
}

export function docFromText(name: string, text: string): JsonDocument {
  const ranges = new Map<string, Range>();
  const value = new Parser(text, ranges, name).parse();
  return { name, text, value, ranges };
}

export function docFromValue(name: string, value: JsonValue): JsonDocument {
  return docFromText(name, JSON.stringify(value, null, 2));
}
