/**
 * 词法器：把金额文本切成 token，保留每个 token 的原字节偏移与字节长度。
 * 字节偏移按 UTF-8 计算（不依赖 Buffer，纯函数实现）。
 */

export type TokenKind = 'digit' | 'unit' | 'zero' | 'sep' | 'dot';

export interface Token {
  /** 全局唯一 id（由 IdAlloc 分配，跨版本单调递增） */
  readonly id: number;
  readonly kind: TokenKind;
  /** 原始文本片段（逐字节保留） */
  readonly text: string;
  /** 在整篇文档中的 UTF-8 字节偏移 */
  readonly byteOffset: number;
  readonly byteLength: number;
  /** kind === 'digit' 时的数值 0-9 */
  readonly digit?: number;
  /** kind === 'unit' 时的位值：10 / 100 / 1000 */
  readonly unitValue?: number;
  /** kind === 'sep' 时的段倍率：1e4（万）/ 1e8（亿） */
  readonly sepValue?: number;
}

export class IdAlloc {
  private nextId = 1;
  alloc(): number {
    return this.nextId++;
  }
}

export class LexError extends Error {
  constructor(message: string, readonly byteOffset: number) {
    super(message);
    this.name = 'LexError';
  }
}

const UNIT_VALUES: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const SEP_VALUES: Record<string, number> = { 万: 1e4, 亿: 1e8 };

export function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

export function lex(text: string, baseByteOffset: number, alloc: IdAlloc): Token[] {
  const tokens: Token[] = [];
  let offset = baseByteOffset;
  for (const ch of text) {
    const len = utf8Length(ch);
    const id = alloc.alloc();
    if (ch >= '0' && ch <= '9') {
      tokens.push({ id, kind: 'digit', text: ch, byteOffset: offset, byteLength: len, digit: ch.charCodeAt(0) - 48 });
    } else if (Object.prototype.hasOwnProperty.call(UNIT_VALUES, ch)) {
      tokens.push({ id, kind: 'unit', text: ch, byteOffset: offset, byteLength: len, unitValue: UNIT_VALUES[ch] });
    } else if (ch === '零' || ch === '〇') {
      tokens.push({ id, kind: 'zero', text: ch, byteOffset: offset, byteLength: len });
    } else if (Object.prototype.hasOwnProperty.call(SEP_VALUES, ch)) {
      tokens.push({ id, kind: 'sep', text: ch, byteOffset: offset, byteLength: len, sepValue: SEP_VALUES[ch] });
    } else if (ch === '.' || ch === '点') {
      tokens.push({ id, kind: 'dot', text: ch, byteOffset: offset, byteLength: len });
    } else {
      throw new LexError(`无法识别的字符 ${JSON.stringify(ch)}`, offset);
    }
    offset += len;
  }
  return tokens;
}
