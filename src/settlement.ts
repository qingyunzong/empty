/** 单个用户在清算范围内的占用秒数。 */
export interface Usage {
  userId: string;
  seconds: number;
}

/** 分账结果：每个用户应得/应付的金额（分）。 */
export interface Share extends Usage {
  amountCents: number;
}

/**
 * 比例分账：把 totalCents 按各用户占用秒数比例分配。
 * - 每份先向下取整：floor(total * seconds / totalSeconds)；
 * - 剩余的分（余分）按“精确余数降序、userId 升序”逐个补齐 1 分；
 * - 金额守恒：Σ amountCents === totalCents。
 * 内部用 BigInt 保证精确余数，不受浮点误差影响。
 */
export function splitBySeconds(totalCents: number, usage: Usage[]): Share[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error(`总分账金额必须为非负整数分: ${totalCents}`);
  }
  const seen = new Set<string>();
  for (const u of usage) {
    if (seen.has(u.userId)) throw new Error(`用户重复: ${u.userId}`);
    seen.add(u.userId);
    if (!Number.isInteger(u.seconds) || u.seconds < 0) {
      throw new Error(`占用秒数必须为非负整数: ${u.userId}=${u.seconds}`);
    }
  }
  const totalSeconds = usage.reduce((sum, u) => sum + u.seconds, 0);
  if (totalSeconds === 0) {
    if (totalCents !== 0) throw new Error("无占用秒数但总分账金额非零，无法分账");
    return usage.map((u) => ({ ...u, amountCents: 0 }));
  }

  const total = BigInt(totalCents);
  const denom = BigInt(totalSeconds);
  const exact = usage.map((u) => {
    const numerator = total * BigInt(u.seconds);
    return {
      userId: u.userId,
      seconds: u.seconds,
      floor: numerator / denom,
      remainder: numerator % denom,
    };
  });

  let leftover = totalCents - exact.reduce((sum, e) => sum + Number(e.floor), 0);

  // 余分分配：精确余数降序，余数相同按 userId 升序。
  const order = [...exact].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const bonus = new Map<string, number>();
  for (const e of order) {
    if (leftover === 0) break;
    bonus.set(e.userId, 1);
    leftover--;
  }
  if (leftover !== 0) throw new Error("余分分配失败：剩余分未发完");

  return exact.map((e) => ({
    userId: e.userId,
    seconds: e.seconds,
    amountCents: Number(e.floor) + (bonus.get(e.userId) ?? 0),
  }));
}
