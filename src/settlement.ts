/**
 * 费用清算：把一段费用按各用户占用秒数比例分账。
 * 每户先向下取分；剩余分按“精确余数降序、用户 ID 升序”逐个分配。
 * 精确计算使用 BigInt，避免浮点误差。
 */
export interface Occupation {
  userId: string;
  seconds: number;
}

export interface Share {
  userId: string;
  seconds: number;
  /** 向下取分前的精确份额 = exactNumerator / totalSeconds（分）。 */
  exactNumerator: bigint;
  totalSeconds: number;
  floorCents: number;
  /** 余分分配中补的 0 或 1 分。 */
  remainderCents: number;
  shareCents: number;
}

export function settleSegment(feeCents: number, occupations: readonly Occupation[]): Share[] {
  if (!Number.isInteger(feeCents) || feeCents < 0) {
    throw new Error(`费用必须为非负整数分：${feeCents}`);
  }
  occupations.forEach((o) => {
    if (!Number.isInteger(o.seconds) || o.seconds < 0) {
      throw new Error(`用户 ${o.userId} 占用秒数非法：${o.seconds}`);
    }
  });
  const ids = new Set(occupations.map((o) => o.userId));
  if (ids.size !== occupations.length) {
    throw new Error("占用列表存在重复用户 ID");
  }

  const totalSeconds = occupations.reduce((sum, o) => sum + o.seconds, 0);
  if (totalSeconds === 0) {
    if (feeCents !== 0) throw new Error("总占用为 0 秒时费用必须为 0");
    return occupations.map((o) => ({
      userId: o.userId,
      seconds: 0,
      exactNumerator: 0n,
      totalSeconds: 0,
      floorCents: 0,
      remainderCents: 0,
      shareCents: 0,
    }));
  }

  const fee = BigInt(feeCents);
  const total = BigInt(totalSeconds);

  const exact = occupations.map((o) => {
    const numerator = fee * BigInt(o.seconds);
    const floor = numerator / total;
    const frac = numerator - floor * total; // 精确余数（0 <= frac < total）
    return { o, numerator, floor, frac };
  });

  let remainder = feeCents - exact.reduce((sum, e) => sum + Number(e.floor), 0);

  // 余分分配：精确余数降序，并列时用户 ID 升序。
  const order = exact
    .map((e, i) => ({ i, frac: e.frac, userId: e.o.userId }))
    .sort((a, b) => {
      if (a.frac !== b.frac) return a.frac > b.frac ? -1 : 1;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });

  const bonus = new Array<number>(occupations.length).fill(0);
  for (const { i } of order) {
    if (remainder <= 0) break;
    bonus[i] = 1;
    remainder -= 1;
  }

  return exact.map((e, i) => {
    const floorCents = Number(e.floor);
    const remainderCents = bonus[i]!;
    return {
      userId: e.o.userId,
      seconds: e.o.seconds,
      exactNumerator: e.numerator,
      totalSeconds,
      floorCents,
      remainderCents,
      shareCents: floorCents + remainderCents,
    };
  });
}

/** 守恒校验：各户分账之和必须等于费用总额。 */
export function assertConservation(feeCents: number, shares: readonly Share[]): void {
  const sum = shares.reduce((s, x) => s + x.shareCents, 0);
  if (sum !== feeCents) {
    throw new Error(`分账不守恒：费用 ${feeCents} 分，分账合计 ${sum} 分`);
  }
}

/** 一段带用户占用的待清算费用。 */
export interface SegmentSettlement {
  segmentId: string;
  feeCents: number;
  occupations: Occupation[];
}

export interface AccountSettlement {
  perSegment: { segmentId: string; feeCents: number; shares: Share[] }[];
  /** 全账各用户合计（分）。 */
  perUserTotals: Map<string, number>;
  totalFeeCents: number;
}

/**
 * 全账清算：逐段分账并汇总到用户。
 * 逐段守恒（每段 Σ=段费用）蕴含全账守恒（Σ=总费用）。
 */
export function settleAccount(segments: readonly SegmentSettlement[]): AccountSettlement {
  const perSegment = segments.map((seg) => {
    const shares = settleSegment(seg.feeCents, seg.occupations);
    assertConservation(seg.feeCents, shares);
    return { segmentId: seg.segmentId, feeCents: seg.feeCents, shares };
  });
  const perUserTotals = new Map<string, number>();
  for (const seg of perSegment) {
    for (const share of seg.shares) {
      perUserTotals.set(share.userId, (perUserTotals.get(share.userId) ?? 0) + share.shareCents);
    }
  }
  const totalFeeCents = segments.reduce((sum, s) => sum + s.feeCents, 0);
  const distributed = [...perUserTotals.values()].reduce((a, b) => a + b, 0);
  if (distributed !== totalFeeCents) {
    throw new Error(`全账不守恒：总费用 ${totalFeeCents} 分，已分 ${distributed} 分`);
  }
  return { perSegment, perUserTotals, totalFeeCents };
}
