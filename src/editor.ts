/**
 * 增量金额编辑器。
 *
 * - 文档按 亿段/万段/个段/小数段 四段建模；词法结构保留原字节与单位来源
 *   （每个 token 记录原文片段、UTF-8 字节偏移、所属段）。
 * - setSegment 只重新词法分析并解析被编辑的那一段，其余段的 token 对象、
 *   token id 与贡献值原样保留，仅重算受影响段并重新汇总总分。
 * - 每次成功编辑发布一个不可变 Version 快照；非法编辑不发布，旧快照不变。
 * - 可查询某金额位（分=1, 角=10, 元=100, ...）由哪些原 token 决定。
 */

import { IdAlloc, LexError, Token, TokenKind, lex } from './lexer.js';
import {
  DigitInfo,
  ParseError,
  SegmentRole,
  buildDigits,
  minNonzeroPlace,
  parseSegmentTokens,
  splitSegments,
} from './parser.js';

export interface TokenRef {
  readonly id: number;
  readonly kind: TokenKind;
  readonly text: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  /** 所属段；段分隔符（万/亿）为 'sep'，小数点为 'dot' */
  readonly role: SegmentRole | 'sep' | 'dot';
}

export interface Version {
  readonly index: number;
  readonly text: string;
  readonly cents: number;
  readonly tokens: readonly TokenRef[];
  readonly digits: readonly DigitInfo[];
  /** 查询某金额位由哪些原 token 决定（place: 分=1, 角=10, 元=100, ...） */
  digitSource(place: number): TokenRef[];
}

interface SegState {
  readonly role: SegmentRole;
  /** 段内容原文（不含 万/亿/小数点） */
  readonly content: string;
  /** 内容 token，byteOffset 为段内相对偏移 */
  readonly tokens: readonly Token[];
  /** 亿/万/小数点 token（ones 段为 null），原文是什么字就保留什么字 */
  readonly marker: Token | null;
  readonly valueCents: number;
  readonly contribs: ReadonlyMap<number, number>;
}

interface DocState {
  yi?: SegState;
  wan?: SegState;
  ones: SegState;
  decimals?: SegState;
}

export type EditResult =
  | { ok: true; version: Version }
  | { ok: false; error: string; byteOffset: number };

export type CreateResult =
  | { ok: true; doc: AmountDocument }
  | { ok: false; error: string; byteOffset: number };

const MARKER_TEXT: Record<SegmentRole, string> = { yi: '亿', wan: '万', ones: '', decimals: '.' };

export class AmountDocument {
  private state: DocState;
  private readonly alloc = new IdAlloc();
  private readonly versions: Version[] = [];

  private constructor(state: DocState) {
    this.state = state;
  }

  static create(text: string): CreateResult {
    const doc = new AmountDocument({ ones: AmountDocument.emptyOnes() });
    const init = doc.replaceAll(text);
    if (!init.ok) return { ok: false, error: init.error, byteOffset: init.byteOffset };
    return { ok: true, doc };
  }

  private static emptyOnes(): SegState {
    return { role: 'ones', content: '', tokens: [], marker: null, valueCents: 0, contribs: new Map() };
  }

  /** 用完整文本初始化（仅 create 调用一次）。 */
  private replaceAll(text: string): EditResult {
    let tokens: Token[];
    try {
      tokens = lex(text, 0, this.alloc);
    } catch (e) {
      if (e instanceof LexError) return { ok: false, error: e.message, byteOffset: e.byteOffset };
      throw e;
    }
    try {
      const groups = splitSegments(tokens);
      const state: DocState = { ones: AmountDocument.emptyOnes() };
      for (const g of groups) {
        const sv = parseSegmentTokens(g.role, g.tokens, g.marker?.byteOffset ?? 0);
        state[g.role] = {
          role: g.role,
          content: g.tokens.map((t) => t.text).join(''),
          tokens: g.tokens,
          marker: g.marker,
          valueCents: sv.valueCents,
          contribs: sv.contribs,
        };
      }
      this.state = state;
      const version = this.buildVersion();
      this.versions.push(version);
      return { ok: true, version };
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, error: e.message, byteOffset: e.byteOffset };
      throw e;
    }
  }

  get versionCount(): number {
    return this.versions.length;
  }

  get currentVersion(): Version {
    return this.versions[this.versions.length - 1] as Version;
  }

  versionAt(index: number): Version {
    const v = this.versions[index];
    if (!v) throw new RangeError(`没有版本 ${index}`);
    return v;
  }

  /**
   * 编辑某一段的内容。content 为段内容（不含 万/亿/小数点）：
   * - yi/wan：传 '' 表示删除该段；
   * - ones：传 '' 清空（要求 yi 或 wan 段存在）；
   * - decimals：传 '' 删除小数部分，否则须为 1-2 位数字。
   * 非法编辑返回错误且不发布新版本，当前状态与旧快照保持不变。
   */
  setSegment(role: SegmentRole, content: string): EditResult {
    let seg: SegState | undefined;
    try {
      seg = this.buildSeg(role, content);
    } catch (e) {
      if (e instanceof LexError || e instanceof ParseError) {
        return { ok: false, error: e.message, byteOffset: e.byteOffset };
      }
      throw e;
    }

    const next: DocState = { ...this.state };
    if (seg === undefined) {
      delete next[role];
    } else {
      next[role] = seg;
    }

    const structuralError = AmountDocument.validateState(next);
    if (structuralError !== null) {
      return { ok: false, error: structuralError, byteOffset: 0 };
    }

    this.state = next;
    const version = this.buildVersion();
    this.versions.push(version);
    return { ok: true, version };
  }

  /** 词法分析并解析单段；content 为空时返回 undefined（删除段）或空 ones 段。 */
  private buildSeg(role: SegmentRole, content: string): SegState | undefined {
    if (content === '') {
      if (role === 'ones') return AmountDocument.emptyOnes();
      return undefined;
    }
    const tokens = lex(content, 0, this.alloc);
    if ((role === 'yi' || role === 'wan') && !tokens.some((t) => t.kind === 'digit')) {
      throw new ParseError(`「${MARKER_TEXT[role]}」段须包含数字`, 0);
    }
    const sv = parseSegmentTokens(role, tokens, 0);
    let marker: Token | null = null;
    if (role !== 'ones') {
      const text = MARKER_TEXT[role];
      marker = { id: this.alloc.alloc(), kind: role === 'decimals' ? 'dot' : 'sep', text, byteOffset: 0, byteLength: text.length === 1 ? utf8ByteLen(text) : 1 };
    }
    return { role, content, tokens, marker, valueCents: sv.valueCents, contribs: sv.contribs };
  }

  private static validateState(state: DocState): string | null {
    const totalTokens =
      (state.yi?.tokens.length ?? 0) +
      (state.wan?.tokens.length ?? 0) +
      state.ones.tokens.length +
      (state.decimals?.tokens.length ?? 0);
    if (totalTokens === 0) return '金额不能为空';
    if (state.ones.tokens.length === 0 && !state.yi && !state.wan) return '整数部分不能为空';
    return null;
  }

  /** 汇总当前状态，生成不可变快照；重排所有 token 的字节偏移。 */
  private buildVersion(): Version {
    const ordered: (SegState | undefined)[] = [this.state.yi, this.state.wan, this.state.ones, this.state.decimals];
    let text = '';
    let byteOffset = 0;
    let cents = 0;
    const tokens: TokenRef[] = [];
    const contribs = new Map<number, number>();

    const pushToken = (t: Token, role: TokenRef['role']): void => {
      tokens.push({ id: t.id, kind: t.kind, text: t.text, byteOffset, byteLength: t.byteLength, role });
      text += t.text;
      byteOffset += t.byteLength;
    };

    for (const seg of ordered) {
      if (!seg) continue;
      cents += seg.valueCents;
      for (const [id, c] of seg.contribs) contribs.set(id, c);
      if (seg.role === 'decimals' && seg.marker) pushToken(seg.marker, 'dot');
      for (const t of seg.tokens) pushToken(t, seg.role);
      if (seg.role !== 'decimals' && seg.marker) pushToken(seg.marker, 'sep');
    }

    const frozenTokens: readonly TokenRef[] = Object.freeze(tokens);
    const digits: readonly DigitInfo[] = Object.freeze(buildDigits(cents, contribs));
    const index = this.versions.length;
    const byId = new Map<number, TokenRef>();
    for (const t of frozenTokens) byId.set(t.id, t);

    return {
      index,
      text,
      cents,
      tokens: frozenTokens,
      digits,
      digitSource(place: number): TokenRef[] {
        const out: TokenRef[] = [];
        for (const [id, c] of contribs) {
          if (c > 0 && minNonzeroPlace(c) <= place) {
            const ref = byId.get(id);
            if (ref) out.push(ref);
          }
        }
        out.sort((a, b) => a.byteOffset - b.byteOffset);
        return out;
      },
    };
  }
}

function utf8ByteLen(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}
