import {
  addMonths,
  daysInMonth,
  type LocalDate,
  type YearMonth,
} from "./dateMath.js";

/** 一周从周几开始：0=周日 … 6=周六。 */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface GridCell {
  /** 该单元格对应的完整公历日期（含邻月补齐格）。 */
  readonly date: LocalDate;
  /** 是否属于本面板月份；false 表示是邻月同号补齐格，禁止点击。 */
  readonly inMonth: boolean;
  /** 在面板网格中的位置（0 起）。 */
  readonly row: number;
  readonly column: number;
}

export interface MonthGrid {
  readonly month: YearMonth;
  readonly weekStartsOn: WeekStart;
  readonly cells: readonly GridCell[];
}

/** 格里高利历：该月 1 号是周几（0=周日）。纯历法计算。 */
export function weekdayOfFirst(year: number, month: number): number {
  // 蔡勒公式变体，3 月起算把 1/2 月当作上一年的 13/14 月。
  let y = year;
  let m = month;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const k = y % 100;
  const j = Math.floor(y / 100);
  const h =
    (1 +
      Math.floor((13 * (m + 1)) / 5) +
      k +
      Math.floor(k / 4) +
      Math.floor(j / 4) +
      5 * j) %
    7;
  // h: 0=周六 … 6=周五 → 转为 0=周日 … 6=周六
  return (h + 6) % 7;
}

/**
 * 构建一个可见月面板的 6×7 网格。
 * 首列由 weekStartsOn 决定；邻月同号格以 inMonth=false 标出，
 * 调用方据此避免误点（例如 11 月面板末尾出现的 12-01）。
 */
export function buildMonthGrid(
  month: YearMonth,
  weekStartsOn: WeekStart,
): MonthGrid {
  const firstWeekday = weekdayOfFirst(month.year, month.month);
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const totalDays = daysInMonth(month.year, month.month);
  const prev = addMonths(month, -1);
  const prevDays = daysInMonth(prev.year, prev.month);
  const next = addMonths(month, 1);

  const cells: GridCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const offset = index - leading; // 相对本月 1 号的天数偏移
    let date: LocalDate;
    let inMonth: boolean;
    if (offset < 0) {
      date = {
        year: prev.year,
        month: prev.month,
        day: prevDays + offset + 1,
      };
      inMonth = false;
    } else if (offset >= totalDays) {
      date = {
        year: next.year,
        month: next.month,
        day: offset - totalDays + 1,
      };
      inMonth = false;
    } else {
      date = { year: month.year, month: month.month, day: offset + 1 };
      inMonth = true;
    }
    cells.push({
      date,
      inMonth,
      row: Math.floor(index / 7),
      column: index % 7,
    });
  }
  return { month, weekStartsOn, cells };
}

/**
 * 在网格中定位目标日期，且只接受本月格（inMonth=true）。
 * 邻月同号格会被显式拒绝，防止误点。
 */
export function findInMonthCell(
  grid: MonthGrid,
  target: LocalDate,
): GridCell | undefined {
  return grid.cells.find(
    (cell) =>
      cell.inMonth &&
      cell.date.year === target.year &&
      cell.date.month === target.month &&
      cell.date.day === target.day,
  );
}
