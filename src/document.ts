import { EditError } from "./errors.js";
import type { Token } from "./lexer.js";
import {
  buildDigitMap,
  computeCents,
  parseAmount,
  type DigitSource,
  type Segment,
  type SegmentKind,
} from "./parser.js";

const DIGITS_RE = /^[0-9]+$/;

function shiftToken(t: Token, delta: number): Token {
  return {
    ...t,
    start: t.start + delta,
    end: t.end + delta,
    byteStart: t.byteStart + delta,
    byteEnd: t.byteEnd + delta,
  };
}

/**
 * 不可变金额文档：每次编辑返回新文档（新快照），旧快照永不改变；
 * 非法编辑抛出 EditError，不产生任何新快照（错误编辑不发布）。
 *
 * 增量性：编辑只替换目标段的数字 token，之前的 token 原样复用，
 * 之后的 token 仅平移偏移量；仅重算被编辑段的 value，
 * 其余段对象结构共享（=== 相等），总分由缓存段值求和得到。
 */
export class AmountDocument {
  private constructor(
    readonly text: string,
    readonly tokens: readonly Token[],
    readonly segments: readonly Segment[],
    readonly fraction: Token | null,
    readonly cents: bigint,
  ) {}

  static create(text: string): AmountDocument {
    const p = parseAmount(text);
    return new AmountDocument(p.text, p.tokens, p.segments, p.fraction, p.cents);
  }

  segment(kind: SegmentKind): Segment | undefined {
    return this.segments.find((s) => s.kind === kind);
  }

  /** 完整解析一次当前文本（用于对照增量结果）。 */
  reparse(): { cents: bigint; digits: readonly DigitSource[] } {
    const p = parseAmount(this.text);
    return { cents: p.cents, digits: p.digits };
  }

  /** 全部金额位（分的每一位）及其来源 token。 */
  digits(): DigitSource[] {
    return buildDigitMap(this.cents, this.segments, this.fraction);
  }

  /** 查询某个金额位（place=0 为最低分位）由哪些原 token 决定。 */
  digitAt(place: number): DigitSource {
    const map = this.digits();
    if (!Number.isInteger(place) || place < 0 || place >= map.length) {
      throw new RangeError(`place 超出范围: ${place}`);
    }
    return map[place]!;
  }

  /** 替换某整数段的数字，返回新文档；非法编辑抛 EditError。 */
  setSegmentDigits(kind: SegmentKind, newDigits: string): AmountDocument {
    const idx = this.segments.findIndex((s) => s.kind === kind);
    if (idx < 0) throw new EditError(`段落不存在: ${kind}`);
    const seg = this.segments[idx]!;
    if (!DIGITS_RE.test(newDigits)) {
      throw new EditError(`段数字非法: 「${newDigits}」`);
    }
    const hasUnitContext = this.segments.some((s) => s.unit !== null);
    const maxLen = kind === "ge" && !hasUnitContext ? Number.MAX_SAFE_INTEGER : 4;
    if (newDigits.length > maxLen) {
      throw new EditError(`段最多 ${maxLen} 位数字`);
    }

    const delta = newDigits.length - seg.digits.raw.length;
    const text =
      this.text.slice(0, seg.digits.start) +
      newDigits +
      this.text.slice(seg.digits.end);

    // 增量词法：编辑点之前的 token 原样复用，之后的仅平移偏移。
    const tokens: Token[] = [];
    let newDigitsToken: Token | null = null;
    for (const t of this.tokens) {
      if (t.index < seg.digits.index) {
        tokens.push(t);
      } else if (t.index === seg.digits.index) {
        newDigitsToken = {
          ...t,
          raw: newDigits,
          end: t.start + newDigits.length,
          byteEnd: t.byteStart + newDigits.length,
        };
        tokens.push(newDigitsToken);
      } else {
        tokens.push(shiftToken(t, delta));
      }
    }

    // 仅重算受影响段的 value；其余段复用缓存 value。
    // 编辑点之后的 token 已平移，引用这些 token 的段需换用新 token 对象；
    // 编辑点之前的段（token 未变）保持对象同一性（结构共享）。
    const tokenMap = new Map<Token, Token>();
    for (let k = 0; k < this.tokens.length; k++) {
      tokenMap.set(this.tokens[k]!, tokens[k]!);
    }
    const newSeg: Segment = {
      ...seg,
      digits: newDigitsToken!,
      unit: seg.unit !== null ? tokenMap.get(seg.unit)! : null,
      value: BigInt(newDigits),
    };
    const segments = this.segments.map((s, i) => {
      if (i === idx) return newSeg;
      const d = tokenMap.get(s.digits)!;
      const u = s.unit !== null ? tokenMap.get(s.unit)! : null;
      if (d === s.digits && u === s.unit) return s;
      return { ...s, digits: d, unit: u };
    });
    // 小数 token 若在编辑点之后，同样换用平移后的新对象
    const fraction = this.fraction !== null ? tokenMap.get(this.fraction)! : null;
    const cents = computeCents(segments, fraction);
    return new AmountDocument(text, tokens, segments, fraction, cents);
  }

  /** 设置（1-2 位数字）或删除（null）小数段，返回新文档。 */
  setFraction(newDigits: string | null): AmountDocument {
    if (newDigits === null) {
      if (this.fraction === null) throw new EditError("没有小数段可删除");
      const dot = this.tokens[this.fraction.index - 1]!;
      const text = this.text.slice(0, dot.start) + this.text.slice(this.fraction.end);
      const tokens = this.tokens.slice(0, this.fraction.index - 1);
      const cents = computeCents(this.segments, null);
      return new AmountDocument(text, tokens, this.segments, null, cents);
    }
    if (!/^[0-9]{1,2}$/.test(newDigits)) {
      throw new EditError(`小数位非法: 「${newDigits}」（须为 1-2 位数字）`);
    }
    if (this.fraction !== null) {
      const frac = this.fraction;
      const text = this.text.slice(0, frac.start) + newDigits + this.text.slice(frac.end);
      const newFrac: Token = {
        ...frac,
        raw: newDigits,
        end: frac.start + newDigits.length,
        byteEnd: frac.byteStart + newDigits.length,
      };
      const tokens = this.tokens.map((t) => (t.index === frac.index ? newFrac : t));
      const cents = computeCents(this.segments, newFrac);
      return new AmountDocument(text, tokens, this.segments, newFrac, cents);
    }
    const start = this.text.length;
    const byteStart = this.tokens.length === 0
      ? 0
      : this.tokens[this.tokens.length - 1]!.byteEnd;
    const dot: Token = {
      kind: "dot",
      raw: ".",
      start,
      end: start + 1,
      byteStart,
      byteEnd: byteStart + 1,
      index: this.tokens.length,
    };
    const frac: Token = {
      kind: "digits",
      raw: newDigits,
      start: start + 1,
      end: start + 1 + newDigits.length,
      byteStart: byteStart + 1,
      byteEnd: byteStart + 1 + newDigits.length,
      index: this.tokens.length + 1,
    };
    const tokens = [...this.tokens, dot, frac];
    const cents = computeCents(this.segments, frac);
    return new AmountDocument(this.text + "." + newDigits, tokens, this.segments, frac, cents);
  }
}
