/**
 * 纯历法（civil calendar）日期运算。
 *
 * 所有运算只在 { year, month, day } 整数结构上进行，
 * 绝不经过 epoch 毫秒或 Date 对象做加减，
 * 因此任何时区的 DST 切换都不会改变纯日期结果。
 */

export interface LocalDate {
  /** 公历年，例如 2026 */
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  /** 1-31 */
  readonly day: number;
}

export interface YearMonth {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new RangeError(`非法月份: ${month}`);
  }
}

export function isValidLocalDate(date: LocalDate): boolean {
  return (
    Number.isInteger(date.year) &&
    Number.isInteger(date.month) &&
    Number.isInteger(date.day) &&
    date.month >= 1 &&
    date.month <= 12 &&
    date.day <= daysInMonth(date.year, date.month) &&
    date.day >= 1
  );
}

export function assertValidLocalDate(date: LocalDate, label = "date"): void {
  if (!isValidLocalDate(date)) {
    throw new RangeError(
      `${label} 不是合法公历日期: ${date.year}-${date.month}-${date.day}`,
    );
  }
}

/** 把年月压成单调递增的月份序号，便于做差值与比较。 */
export function monthIndex(ym: YearMonth): number {
  return ym.year * 12 + (ym.month - 1);
}

export function fromMonthIndex(index: number): YearMonth {
  const year = Math.floor(index / 12);
  return { year, month: index - year * 12 + 1 };
}

/** 纯历法月份偏移，不经过任何时间戳。 */
export function addMonths(ym: YearMonth, delta: number): YearMonth {
  return fromMonthIndex(monthIndex(ym) + delta);
}

/** a 与 b 的月份差（a - b，单位：月）。 */
export function monthDiff(a: YearMonth, b: YearMonth): number {
  return monthIndex(a) - monthIndex(b);
}

export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

export function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}
