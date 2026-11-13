import type { LocalDate } from "./dateMath.js";

/**
 * 校验 IANA 时区标识是否可被当前运行环境识别。
 * 时区只用于“定位今天/校验环境”，绝不参与日期加减，
 * 因此 DST 不影响规划结果。
 */
export function assertValidTimeZone(timeZone: string): void {
  try {
    // Intl 会对非法时区抛 RangeError。
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new RangeError(`无法识别的 IANA 时区: ${timeZone}`);
  }
}

/**
 * 取指定时区下“现在”的本地纯日期。
 * 只读取 Intl 拆分出的年月日字段，不做任何毫秒运算。
 */
export function todayInTimeZone(
  timeZone: string,
  now: Date = new Date(),
): LocalDate {
  assertValidTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const pick = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl 未返回 ${type} 字段`);
    return Number(part.value);
  };
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}
