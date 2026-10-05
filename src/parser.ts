import { ParseError } from "./errors.js";
import { lex, type Token } from "./lexer.js";

export const SCALE_YI = 100_000_000n;
export const SCALE_WAN = 10_000n;

export type SegmentKind = "yi" | "wan" | "ge";

/** 整数段：数字 token + 可选单位 token（单位来源），scale 为量级。 */
export interface Segment {
  readonly kind: SegmentKind;
  readonly digits: Token;
  readonly unit: Token | null;
  readonly scale: bigint;
  readonly value: bigint;
}

/** 输出（分）的某一位：字符 + 决定该位的原 token 列表；空列表表示隐式零。 */
export interface DigitSource {
  readonly place: number;
  readonly char: string;
  readonly sources: readonly Token[];
}

export interface ParsedAmount {
  readonly text: string;
  readonly tokens: readonly Token[];
  readonly segments: readonly Segment[];
  readonly fraction: Token | null;
  readonly cents: bigint;
  readonly digits: readonly DigitSource[];
}

const UNIT_RANK: Record<string, number> = { 亿: 2, 万: 1 };
const UNIT_SCALE: Record<string, bigint> = { 亿: SCALE_YI, 万: SCALE_WAN };

function segmentKind(scale: bigint): SegmentKind {
  if (scale === SCALE_YI) return "yi";
  if (scale === SCALE_WAN) return "wan";
  return "ge";
}

function scaleLog(scale: bigint): number {
  if (scale === SCALE_YI) return 8;
  if (scale === SCALE_WAN) return 4;
  return 0;
}

export function computeCents(
  segments: readonly Segment[],
  fraction: Token | null,
): bigint {
  let yuan = 0n;
  for (const seg of segments) yuan += seg.value * seg.scale;
  let cents = yuan * 100n;
  if (fraction !== null) {
    cents += BigInt(fraction.raw) * (fraction.raw.length === 1 ? 10n : 1n);
  }
  return cents;
}

/**
 * 每位来源映射。各段量级互不重叠（亿段 8..11 位、万段 4..7 位、个段 0..3 位，
 * 且带单位的段强制 1..4 位、值 <= 9999，段间无进位），因此每个十进制位
 * 恰好落在至多一个段的覆盖范围内；未被覆盖的位为隐式零。
 */
export function buildDigitMap(
  cents: bigint,
  segments: readonly Segment[],
  fraction: Token | null,
): DigitSource[] {
  const centsStr = cents.toString();
  const out: DigitSource[] = [];
  for (let place = 0; place < centsStr.length; place++) {
    const char = centsStr[centsStr.length - 1 - place]!;
    let sources: Token[] = [];
    if (place < 2) {
      if (fraction !== null) sources = [fraction];
    } else {
      const yuanPlace = place - 2;
      for (const seg of segments) {
        const base = scaleLog(seg.scale);
        const len = seg.digits.raw.length;
        if (yuanPlace >= base && yuanPlace < base + len) {
          sources = seg.unit !== null ? [seg.digits, seg.unit] : [seg.digits];
          break;
        }
      }
    }
    out.push({ place, char, sources });
  }
  return out;
}

export function parseAmount(text: string): ParsedAmount {
  const tokens = lex(text);
  const segments: Segment[] = [];
  let fraction: Token | null = null;
  let lastRank = Number.POSITIVE_INFINITY;
  let sawIntDigits = false;
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === "dot") break;
    if (t.kind === "unit") {
      throw new ParseError(
        "MISSING_DIGITS_BEFORE_UNIT",
        `单位「${t.raw}」前缺少数字`,
        t.start,
      );
    }
    sawIntDigits = true;
    const next = tokens[i + 1];
    if (next !== undefined && next.kind === "unit") {
      if (t.raw.length > 4) {
        throw new ParseError(
          "SEGMENT_TOO_LONG",
          `单位「${next.raw}」前的段最多 4 位数字`,
          t.start,
        );
      }
      const rank = UNIT_RANK[next.raw]!;
      if (rank === lastRank) {
        throw new ParseError(
          "DUPLICATE_UNIT",
          `重复单位「${next.raw}」`,
          next.start,
        );
      }
      if (rank > lastRank) {
        throw new ParseError(
          "UNIT_ORDER",
          "单位必须递减（亿 在 万 前）",
          next.start,
        );
      }
      const scale = UNIT_SCALE[next.raw]!;
      segments.push({
        kind: segmentKind(scale),
        digits: t,
        unit: next,
        scale,
        value: BigInt(t.raw),
      });
      lastRank = rank;
      i += 2;
    } else {
      if (segments.length > 0 && t.raw.length > 4) {
        throw new ParseError(
          "SEGMENT_TOO_LONG",
          "带单位时的末段最多 4 位数字",
          t.start,
        );
      }
      segments.push({
        kind: "ge",
        digits: t,
        unit: null,
        scale: 1n,
        value: BigInt(t.raw),
      });
      i += 1;
      break;
    }
  }

  if (i < tokens.length && tokens[i]!.kind === "dot") {
    const dot = tokens[i]!;
    const frac = tokens[i + 1];
    if (frac === undefined || frac.kind !== "digits") {
      throw new ParseError("MISSING_FRACTION", "小数点后缺少数字", dot.start);
    }
    if (frac.raw.length > 2) {
      throw new ParseError(
        "FRACTION_TOO_LONG",
        "小数最多两位",
        frac.start,
      );
    }
    fraction = frac;
    i += 2;
  }

  if (i < tokens.length) {
    const t = tokens[i]!;
    throw new ParseError(
      "UNEXPECTED_TOKEN",
      `无法解析的 token「${t.raw}」`,
      t.start,
    );
  }
  if (!sawIntDigits) {
    throw new ParseError("NO_DIGITS", "缺少整数数字", 0);
  }

  const cents = computeCents(segments, fraction);
  return {
    text,
    tokens,
    segments,
    fraction,
    cents,
    digits: buildDigitMap(cents, segments, fraction),
  };
}
