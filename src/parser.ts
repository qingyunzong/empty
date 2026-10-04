/**
 * 解析器：中文金额文本 -> 整数分 + 每个金额位的来源 token。
 *
 * 语法（EBNF 风格）：
 *   amount   := [yiSeg '亿'] [wanSeg '万'] [onesSeg] [('.' | '点') dec]
 *   yiSeg/wanSeg/onesSeg := segment            -- 每段数值 0..9999
 *   segment  := item*                          -- 数字、十/百/千、零 的序列
 *   dec      := digit digit?                   -- 至多两位小数
 *
 * 规则：
 *   - 段内单位（十/百/千）必须严格递减，重复或逆序即拒绝；
 *   - 「零」是占位符：自身贡献为 0，不改变量级；它截断当前位置链，
 *     其后的裸数字按普通整数累加（如 1千零5 = 1005）；
 *   - 单位前的连续数字整体作为该单位的系数（12千 = 12000，但受每段 <=9999 限制）；
 *   - 单位后的裸数字按递减数位落位（3千12 = 3120），落到个位以下即报错；
 *   - 万/亿 之前必须有数字；万、亿至多各出现一次且 亿 在 万 前；
 *   - 小数部分仅允许 1-2 位数字；
 *   - 每段数值上限 9999（四位分组语义），全量上限 9999亿9999万9999.99。
 *
 * 来源（provenance）定义：结果分位 p 上的数字，由所有「贡献值的最低非零位 <= p」
 * 的 token 共同决定（加法进位只向上传播，故更高位的 token 不可能影响该位）。
 * 贡献为 0 的 token（单位、零、分隔符、数字 0）不决定任何位。
 */

import { IdAlloc, LexError, Token, lex } from './lexer.js';

export type SegmentRole = 'yi' | 'wan' | 'ones' | 'decimals';

/** 各段 1 元对应的分数 */
export const ROLE_CENTS_MULT: Record<SegmentRole, number> = {
  yi: 1e8 * 100,
  wan: 1e4 * 100,
  ones: 100,
  decimals: 1,
};

export const MAX_SEGMENT_VALUE = 9999;
export const MAX_CENTS = 9999 * 1e8 * 100 + 9999 * 1e4 * 100 + 9999 * 100 + 99; // 99999999999999

export class ParseError extends Error {
  constructor(message: string, readonly byteOffset: number) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface SegmentValue {
  /** 该段对总分值的贡献 */
  valueCents: number;
  /** tokenId -> 该 token 贡献的分值（仅数字 token 有非零值） */
  contribs: Map<number, number>;
}

function parseDecimals(tokens: Token[], fallbackOffset: number): SegmentValue {
  if (tokens.length < 1 || tokens.length > 2) {
    throw new ParseError('小数部分须为 1 至 2 位数字', tokens[0]?.byteOffset ?? fallbackOffset);
  }
  const contribs = new Map<number, number>();
  let value = 0;
  let place = 10;
  for (const tok of tokens) {
    if (tok.kind !== 'digit') throw new ParseError('小数部分只允许数字', tok.byteOffset);
    const c = (tok.digit as number) * place;
    value += c;
    contribs.set(tok.id, c);
    place /= 10;
  }
  return { valueCents: value, contribs };
}

/** 解析单个整数段（yi/wan/ones 的内容，不含 万/亿 字）或小数段。 */
export function parseSegmentTokens(role: SegmentRole, tokens: Token[], fallbackOffset = 0): SegmentValue {
  if (role === 'decimals') return parseDecimals(tokens, fallbackOffset);

  let value = 0; // 段内元值
  const contribs = new Map<number, number>();
  let lastUnit = Infinity; // 上一个单位位值，必须严格递减
  let nextPlace: number | null = null; // 单位之后，下一个裸数字的数位；null 表示普通整数模式
  let pending: Token[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    if (nextPlace !== null) {
      // 位置模式：从 nextPlace 开始逐位下降
      let place = nextPlace;
      for (const tok of pending) {
        if (place < 1) throw new ParseError('数位超出个位', tok.byteOffset);
        const c = (tok.digit as number) * place;
        value += c;
        contribs.set(tok.id, c);
        place /= 10;
      }
      nextPlace = place;
    } else {
      // 普通整数模式：最右数字为个位
      let place = 1;
      for (let i = pending.length - 1; i >= 0; i--) {
        const c = (pending[i] as Token).digit! * place;
        value += c;
        contribs.set((pending[i] as Token).id, c);
        place *= 10;
      }
    }
    pending = [];
  };

  for (const tok of tokens) {
    switch (tok.kind) {
      case 'digit':
        pending.push(tok);
        break;
      case 'zero':
        // 零占位：自身无贡献；截断位置链，后续裸数字按普通整数累加
        flushPending();
        nextPlace = null;
        break;
      case 'unit': {
        if (pending.length === 0) {
          throw new ParseError(`单位「${tok.text}」前缺少数字`, tok.byteOffset);
        }
        const u = tok.unitValue as number;
        if (!(u < lastUnit)) {
          throw new ParseError(`单位「${tok.text}」重复或未按递减顺序出现`, tok.byteOffset);
        }
        let place = u;
        for (let i = pending.length - 1; i >= 0; i--) {
          const c = (pending[i] as Token).digit! * place;
          value += c;
          contribs.set((pending[i] as Token).id, c);
          place *= 10;
        }
        pending = [];
        lastUnit = u;
        nextPlace = u / 10;
        break;
      }
      default:
        throw new ParseError(`段内不允许出现「${tok.text}」`, tok.byteOffset);
    }
  }
  flushPending();

  if (value > MAX_SEGMENT_VALUE) {
    throw new ParseError(`段数值 ${value} 超出每段上限 ${MAX_SEGMENT_VALUE}`, tokens[0]?.byteOffset ?? fallbackOffset);
  }
  const mult = ROLE_CENTS_MULT[role];
  const scaled = new Map<number, number>();
  for (const [id, c] of contribs) scaled.set(id, c * mult);
  return { valueCents: value * mult, contribs: scaled };
}

export interface SegmentGroup {
  role: SegmentRole;
  tokens: Token[];
  /** yi/wan 段的 亿/万 token，decimals 段的小数点 token，ones 段为 null */
  marker: Token | null;
}

/** 把 token 流按 亿/万/小数点 切成段，并校验分隔结构。 */
export function splitSegments(tokens: Token[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  let current: Token[] = [];
  let sepSeen: 'none' | 'yi' | 'wan' = 'none';
  let role: SegmentRole = 'ones';
  let dotSeen = false;
  let dotToken: Token | null = null;

  const flush = (marker: Token | null): void => {
    groups.push({ role, tokens: current, marker });
    current = [];
  };

  for (const tok of tokens) {
    if (tok.kind === 'sep') {
      if (dotSeen) throw new ParseError('小数点后不允许出现万/亿', tok.byteOffset);
      if (!current.some((t) => t.kind === 'digit')) {
        throw new ParseError(`「${tok.text}」前缺少数字`, tok.byteOffset);
      }
      if (tok.sepValue === 1e8) {
        if (sepSeen !== 'none') throw new ParseError('「亿」只能出现一次，且须位于「万」之前', tok.byteOffset);
        role = 'yi';
        flush(tok);
        sepSeen = 'yi';
      } else {
        if (sepSeen === 'wan') throw new ParseError('「万」重复出现', tok.byteOffset);
        role = 'wan';
        flush(tok);
        sepSeen = 'wan';
      }
      role = 'ones';
    } else if (tok.kind === 'dot') {
      if (dotSeen) throw new ParseError('小数点重复出现', tok.byteOffset);
      dotSeen = true;
      dotToken = tok;
      flush(null);
      role = 'decimals';
    } else {
      if (dotSeen && tok.kind !== 'digit') throw new ParseError('小数部分只允许数字', tok.byteOffset);
      current.push(tok);
    }
  }
  flush(role === 'decimals' ? dotToken : null);

  const ones = groups.find((g) => g.role === 'ones');
  const hasYiWan = groups.some((g) => g.role === 'yi' || g.role === 'wan');
  if (ones && ones.tokens.length === 0 && !hasYiWan) {
    const dot = groups.find((g) => g.role === 'decimals');
    throw new ParseError('整数部分不能为空', dot?.marker?.byteOffset ?? 0);
  }
  return groups;
}

export interface DigitInfo {
  /** 数位（分=1, 角=10, 元=100, ...） */
  place: number;
  /** 该位数字 0-9 */
  digit: number;
  /** 决定该位的来源 token id 列表 */
  tokenIds: number[];
}

/** 贡献值 c 的最低非零数位；c=0 时为 Infinity（不决定任何位）。 */
export function minNonzeroPlace(c: number): number {
  if (c === 0) return Infinity;
  let p = 1;
  while (c % (p * 10) === 0) p *= 10;
  return p;
}

export function buildDigits(cents: number, contribs: ReadonlyMap<number, number>): DigitInfo[] {
  const entries: { id: number; minPlace: number }[] = [];
  for (const [id, c] of contribs) {
    if (c > 0) entries.push({ id, minPlace: minNonzeroPlace(c) });
  }
  let maxPlace = 1;
  while (maxPlace * 10 <= cents) maxPlace *= 10;
  const digits: DigitInfo[] = [];
  for (let p = 1; p <= maxPlace; p *= 10) {
    const digit = Math.floor(cents / p) % 10;
    digits.push({ place: p, digit, tokenIds: entries.filter((e) => e.minPlace <= p).map((e) => e.id) });
  }
  return digits;
}

export interface ParseSuccess {
  ok: true;
  text: string;
  cents: number;
  tokens: Token[];
  digits: DigitInfo[];
}

export interface ParseFailure {
  ok: false;
  error: string;
  byteOffset: number;
}

export type ParseResult = ParseSuccess | ParseFailure;

export function parseAmount(text: string): ParseResult {
  let tokens: Token[];
  try {
    tokens = lex(text, 0, new IdAlloc());
  } catch (e) {
    if (e instanceof LexError) return { ok: false, error: e.message, byteOffset: e.byteOffset };
    throw e;
  }
  try {
    const groups = splitSegments(tokens);
    let cents = 0;
    const contribs = new Map<number, number>();
    for (const g of groups) {
      const sv = parseSegmentTokens(g.role, g.tokens, g.marker?.byteOffset ?? 0);
      cents += sv.valueCents;
      for (const [id, c] of sv.contribs) contribs.set(id, c);
    }
    return { ok: true, text, cents, tokens, digits: buildDigits(cents, contribs) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, byteOffset: e.byteOffset };
    throw e;
  }
}
