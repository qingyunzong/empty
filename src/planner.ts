import {
  addMonths,
  assertValidLocalDate,
  monthIndex,
  sameMonth,
  type LocalDate,
  type YearMonth,
} from "./dateMath.js";
import {
  buildMonthGrid,
  findInMonthCell,
  type WeekStart,
} from "./grid.js";
import { assertValidTimeZone } from "./timezone.js";

export interface PlanRequest {
  /** 目标本地纯日期（公历），DST 不会使其漂移。 */
  readonly targetDate: LocalDate;
  /** 页面所在 IANA 时区，例如 "America/New_York"。仅用于校验与记录。 */
  readonly timeZone: string;
  /** 首周日规则：0=周日 … 6=周六。 */
  readonly weekStartsOn: WeekStart;
  /** 当前可见的月份面板（按 DOM 顺序，必须连续递增）。 */
  readonly visibleMonths: readonly YearMonth[];
  /**
   * 可选：面板标题格式化器，需与页面实际渲染一致。
   * 默认输出 "YYYY-MM"。
   */
  readonly formatTitle?: (month: YearMonth, panelIndex: number) => string;
}

export type PickerAction =
  | {
      readonly type: "navigate";
      readonly direction: "prev" | "next";
      /** 本次是连续跳转中的第几步（1 起）。 */
      readonly step: number;
      readonly totalSteps: number;
    }
  | {
      readonly type: "verifyHeader";
      /** 跳转后每个面板标题的期望值，必须回读比对后再继续。 */
      readonly expectedTitles: readonly string[];
    }
  | {
      readonly type: "clickDate";
      readonly date: LocalDate;
      /** 目标所在面板下标（0 起）。 */
      readonly panelIndex: number;
      /** 目标格在面板 6×7 网格中的位置。 */
      readonly row: number;
      readonly column: number;
      /** 恒为 true：只点本月格，邻月同号格永不作为目标。 */
      readonly inMonth: true;
    };

export interface PlanResult {
  readonly actions: readonly PickerAction[];
  readonly targetDate: LocalDate;
  readonly timeZone: string;
}

function defaultFormatTitle(month: YearMonth): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function assertConsecutive(months: readonly YearMonth[]): void {
  if (months.length === 0) {
    throw new RangeError("visibleMonths 不能为空");
  }
  for (let index = 1; index < months.length; index += 1) {
    if (monthIndex(months[index]) !== monthIndex(months[index - 1]) + 1) {
      throw new RangeError(
        `visibleMonths 必须是连续递增的月份: 第 ${index} 项不连续`,
      );
    }
  }
}

function buildActions(request: PlanRequest): PickerAction[] {
  assertValidLocalDate(request.targetDate, "targetDate");
  assertValidTimeZone(request.timeZone);
  assertConsecutive(request.visibleMonths);
  const formatTitle = request.formatTitle ?? defaultFormatTitle;

  const targetMonth: YearMonth = {
    year: request.targetDate.year,
    month: request.targetDate.month,
  };
  const first = request.visibleMonths[0];
  const last = request.visibleMonths[request.visibleMonths.length - 1];

  const actions: PickerAction[] = [];
  let months = [...request.visibleMonths];

  const alreadyVisible = months.some((m) => sameMonth(m, targetMonth));
  if (!alreadyVisible) {
    const direction: "prev" | "next" =
      monthIndex(targetMonth) < monthIndex(first) ? "prev" : "next";
    const totalSteps =
      direction === "prev"
        ? monthIndex(first) - monthIndex(targetMonth)
        : monthIndex(targetMonth) - monthIndex(last);
    const delta = direction === "prev" ? -1 : 1;

    for (let step = 1; step <= totalSteps; step += 1) {
      actions.push({ type: "navigate", direction, step, totalSteps });
      months = months.map((m) => addMonths(m, delta));
      // 每次跳转后必须回读标题验证，才能继续下一步。
      actions.push({
        type: "verifyHeader",
        expectedTitles: months.map((m, i) => formatTitle(m, i)),
      });
    }
  }

  const panelIndex = months.findIndex((m) => sameMonth(m, targetMonth));
  const grid = buildMonthGrid(months[panelIndex], request.weekStartsOn);
  const cell = findInMonthCell(grid, request.targetDate);
  if (!cell) {
    // 理论上不可达：目标月可见且日期合法时必存在本月格。
    throw new Error(
      `目标日期 ${targetMonth.year}-${targetMonth.month}-${request.targetDate.day} 在面板 ${panelIndex} 中无本月格`,
    );
  }
  actions.push({
    type: "clickDate",
    date: request.targetDate,
    panelIndex,
    row: cell.row,
    column: cell.column,
    inMonth: true,
  });
  return actions;
}

/** 一次性规划：返回包含导航、标题验证、点击的完整动作序列。 */
export function planDateSelection(request: PlanRequest): PlanResult {
  return {
    actions: buildActions(request),
    targetDate: request.targetDate,
    timeZone: request.timeZone,
  };
}

/**
 * 会话式执行器：逐个吐出动作。
 * 遇到 verifyHeader 时会暂停，必须调用 confirmTitles(actual)
 * 且与期望一致才放行后续动作——从机制上保证
 * “月份跳转后必须回读标题验证再继续”。
 */
export function createPlanSession(request: PlanRequest) {
  const actions = buildActions(request);
  let cursor = 0;
  let pendingVerify: readonly string[] | null = null;

  return {
    /** 取下一个可执行动作；等待标题验证时返回 undefined。 */
    next(): PickerAction | undefined {
      if (pendingVerify) return undefined;
      const action = actions[cursor];
      if (!action) return undefined;
      cursor += 1;
      if (action.type === "verifyHeader") {
        pendingVerify = action.expectedTitles;
      }
      return action;
    },
    /** 是否正等待回读标题确认。 */
    awaitingVerification(): boolean {
      return pendingVerify !== null;
    },
    /** 当前期望的面板标题（无待验证项时为 null）。 */
    expectedTitles(): readonly string[] | null {
      return pendingVerify;
    },
    /**
     * 用页面实际回读的标题确认。不一致则抛错并终止会话，
     * 调用方应中止本次选择流程。
     */
    confirmTitles(actualTitles: readonly string[]): void {
      if (!pendingVerify) {
        throw new Error("当前没有待验证的标题");
      }
      const expected = pendingVerify;
      const mismatch =
        expected.length !== actualTitles.length ||
        expected.some((title, i) => title !== actualTitles[i]);
      if (mismatch) {
        cursor = actions.length;
        throw new Error(
          `面板标题验证失败: 期望 [${expected.join(", ")}]，实际 [${actualTitles.join(", ")}]`,
        );
      }
      pendingVerify = null;
    },
    /** 是否已吐出全部动作。 */
    done(): boolean {
      return cursor >= actions.length && pendingVerify === null;
    },
  };
}
