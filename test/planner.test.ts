import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMonths,
  buildMonthGrid,
  createPlanSession,
  findInMonthCell,
  planDateSelection,
  todayInTimeZone,
  weekdayOfFirst,
  type PickerAction,
  type PlanRequest,
} from "../index.js";

const base: PlanRequest = {
  targetDate: { year: 2026, month: 11, day: 15 },
  timeZone: "America/New_York",
  weekStartsOn: 0,
  visibleMonths: [{ year: 2026, month: 11 }],
};

describe("纯历法运算（DST 安全）", () => {
  it("月份偏移不经过时间戳，跨年正确", () => {
    assert.deepEqual(addMonths({ year: 2026, month: 11 }, 3), {
      year: 2027,
      month: 2,
    });
    assert.deepEqual(addMonths({ year: 2026, month: 1 }, -1), {
      year: 2025,
      month: 12,
    });
  });

  it("蔡勒公式求星期：2026-11-01 是周日", () => {
    assert.equal(weekdayOfFirst(2026, 11), 0);
    assert.equal(weekdayOfFirst(2026, 1), 4); // 2026-01-01 周四
  });

  it("同一时刻不同时区给出各自本地纯日期", () => {
    const instant = new Date("2026-03-08T12:00:00Z"); // 美东 DST 切换日
    assert.deepEqual(todayInTimeZone("America/New_York", instant), {
      year: 2026,
      month: 3,
      day: 8,
    });
    assert.deepEqual(todayInTimeZone("Pacific/Auckland", instant), {
      year: 2026,
      month: 3,
      day: 9,
    });
  });

  it("DST 切换日前后的目标日期规划完全一致（纯日期不漂移）", () => {
    const before = planDateSelection({
      ...base,
      targetDate: { year: 2026, month: 3, day: 7 },
      visibleMonths: [{ year: 2026, month: 1 }],
    });
    const after = planDateSelection({
      ...base,
      targetDate: { year: 2026, month: 3, day: 9 },
      visibleMonths: [{ year: 2026, month: 1 }],
    });
    const navs = (r: typeof before) =>
      r.actions.filter((a) => a.type === "navigate").length;
    assert.equal(navs(before), 2);
    assert.equal(navs(after), 2);
    const click = after.actions.find((a) => a.type === "clickDate");
    assert.deepEqual(click && "date" in click && click.date, {
      year: 2026,
      month: 3,
      day: 9,
    });
  });
});

describe("月视图网格与邻月同号格", () => {
  it("周日开头：2026-11 无前置邻月格，末尾补 12 月格", () => {
    const grid = buildMonthGrid({ year: 2026, month: 11 }, 0);
    assert.equal(grid.cells.length, 42);
    assert.deepEqual(grid.cells[0].date, { year: 2026, month: 11, day: 1 });
    assert.equal(grid.cells[0].inMonth, true);
    const trailing = grid.cells[30];
    assert.deepEqual(trailing.date, { year: 2026, month: 12, day: 1 });
    assert.equal(trailing.inMonth, false);
  });

  it("周一开头：前置格为 10 月 26-31 且 inMonth=false", () => {
    const grid = buildMonthGrid({ year: 2026, month: 11 }, 1);
    assert.equal(grid.cells[0].inMonth, false);
    assert.deepEqual(grid.cells[0].date, { year: 2026, month: 10, day: 26 });
    assert.deepEqual(grid.cells[6].date, { year: 2026, month: 11, day: 1 });
    assert.equal(grid.cells[6].inMonth, true);
  });

  it("邻月同号格不会被当作目标（12-01 在 11 月面板中不可点）", () => {
    const grid = buildMonthGrid({ year: 2026, month: 11 }, 0);
    assert.equal(
      findInMonthCell(grid, { year: 2026, month: 12, day: 1 }),
      undefined,
    );
    const nov1 = findInMonthCell(grid, { year: 2026, month: 11, day: 1 });
    assert.equal(nov1?.inMonth, true);
    assert.equal(nov1?.row, 0);
    assert.equal(nov1?.column, 0);
  });
});

describe("动作规划", () => {
  it("目标月已可见：直接点击，无导航", () => {
    const plan = planDateSelection(base);
    assert.equal(plan.actions.length, 1);
    const action = plan.actions[0];
    assert.equal(action.type, "clickDate");
    if (action.type === "clickDate") {
      assert.equal(action.panelIndex, 0);
      assert.equal(action.inMonth, true);
      // 2026-11-15：11-01 在 index 0 → 15 在 index 14 → row 2, col 0
      assert.equal(action.row, 2);
      assert.equal(action.column, 0);
    }
  });

  it("双面板：目标落在第二面板", () => {
    const plan = planDateSelection({
      ...base,
      targetDate: { year: 2026, month: 12, day: 25 },
      visibleMonths: [
        { year: 2026, month: 11 },
        { year: 2026, month: 12 },
      ],
    });
    const click = plan.actions.find((a) => a.type === "clickDate");
    assert.equal(click?.type, "clickDate");
    if (click?.type === "clickDate") {
      assert.equal(click.panelIndex, 1);
    }
    assert.equal(plan.actions.some((a) => a.type === "navigate"), false);
  });

  it("向后翻 3 个月：每次跳转后都紧跟标题验证", () => {
    const plan = planDateSelection({
      ...base,
      targetDate: { year: 2027, month: 2, day: 10 },
    });
    const types = plan.actions.map((a) => a.type);
    assert.deepEqual(types, [
      "navigate",
      "verifyHeader",
      "navigate",
      "verifyHeader",
      "navigate",
      "verifyHeader",
      "clickDate",
    ]);
    const verifies = plan.actions.filter((a) => a.type === "verifyHeader");
    assert.deepEqual(verifies[0], {
      type: "verifyHeader",
      expectedTitles: ["2026-12"],
    });
      assert.deepEqual(verifies[2], {
      type: "verifyHeader",
      expectedTitles: ["2027-02"],
    });
  });

  it("向前翻月：direction=prev 且标题逐月递减", () => {
    const plan = planDateSelection({
      ...base,
      targetDate: { year: 2026, month: 8, day: 5 },
    });
    const navs = plan.actions.filter((a) => a.type === "navigate");
    assert.equal(navs.length, 3);
    assert.ok(navs.every((a) => a.type === "navigate" && a.direction === "prev"));
    const verifies = plan.actions.filter((a) => a.type === "verifyHeader");
    assert.deepEqual(verifies.map((v) => v.expectedTitles), [
      ["2026-10"],
      ["2026-09"],
      ["2026-08"],
    ]);
  });

  it("自定义标题格式器参与验证期望值", () => {
    const plan = planDateSelection({
      ...base,
      targetDate: { year: 2026, month: 12, day: 1 },
      formatTitle: (m) => `${m.year}年${m.month}月`,
    });
    const verify = plan.actions.find((a) => a.type === "verifyHeader");
    assert.deepEqual(verify, {
      type: "verifyHeader",
      expectedTitles: ["2026年12月"],
    });
  });

  it("非法输入直接抛错", () => {
    assert.throws(() =>
      planDateSelection({
        ...base,
        targetDate: { year: 2026, month: 2, day: 29 }, // 2026 非闰年
      }),
    );
    assert.throws(() =>
      planDateSelection({ ...base, timeZone: "Mars/Olympus" }),
    );
    assert.throws(() =>
      planDateSelection({
        ...base,
        visibleMonths: [
          { year: 2026, month: 11 },
          { year: 2027, month: 1 },
        ],
      }),
    );
    assert.throws(() => planDateSelection({ ...base, visibleMonths: [] }));
  });
});

describe("会话式执行（强制回读验证）", () => {
  const request: PlanRequest = {
    ...base,
    targetDate: { year: 2027, month: 1, day: 20 },
  };

  it("跳转后必须 confirmTitles 才会放行后续动作", () => {
    const session = createPlanSession(request);
    const emitted: PickerAction[] = [];
    let action = session.next();
    while (action) {
      emitted.push(action);
      if (action.type === "verifyHeader") {
        assert.equal(session.awaitingVerification(), true);
        assert.equal(session.next(), undefined); // 未确认前被阻断
        session.confirmTitles([...action.expectedTitles]); // 模拟回读一致
      }
      action = session.next();
    }
    assert.equal(session.done(), true);
    assert.equal(emitted.filter((a) => a.type === "navigate").length, 2);
    assert.equal(emitted.at(-1)?.type, "clickDate");
  });

  it("回读标题不一致则抛错并终止会话", () => {
    const session = createPlanSession(request);
    assert.equal(session.next()?.type, "navigate");
    assert.equal(session.next()?.type, "verifyHeader");
    assert.throws(() => session.confirmTitles(["1999-01"]));
    assert.equal(session.next(), undefined); // 会话已终止
  });

  it("无待验证项时 confirmTitles 抛错", () => {
    const session = createPlanSession(base);
    assert.throws(() => session.confirmTitles([]));
  });
});
