# 日期选择器跨时区操作

跨地区 RPA 需要可直接接入 TypeScript 日期选择规划库，输入目标本地日期、页面时区、首周日规则和可见月份结构，输出上一月/下一月及日期单元操作。DST 不改变纯日期，邻月同号单元不能误点；月份跳转后必须回读标题验证再继续。

## 设计要点

- **纯历法运算**：所有日期加减只在 `{ year, month, day }` 整数结构上进行（`src/dateMath.ts`），不经过 epoch 毫秒，DST 切换不会使目标日期漂移；时区仅用于校验与“取今天”（`src/timezone.ts`）。
- **邻月同号防误点**：每个可见面板构建 6×7 网格（`src/grid.ts`），邻月补齐格标记 `inMonth: false`，点击动作只指向本月格，并携带 `panelIndex / row / column` 精确定位。
- **跳转后强制验证**：每次 `prev`/`next` 导航后紧跟 `verifyHeader` 动作，携带各面板标题期望值；会话式执行器在标题确认前阻断后续动作。

## 快速开始

```ts
import { createPlanSession, planDateSelection } from "dlks-de-0058";

const request = {
  targetDate: { year: 2027, month: 2, day: 10 }, // 目标本地纯日期
  timeZone: "America/New_York",                  // 页面 IANA 时区
  weekStartsOn: 0,                               // 0=周日 … 6=周六
  visibleMonths: [{ year: 2026, month: 11 }],    // 当前可见面板（连续递增）
  // formatTitle: (m) => `${m.year}年${m.month}月`, // 可选，与页面渲染一致
};

// 方式一：一次性取完整动作序列（navigate / verifyHeader / clickDate）
const { actions } = planDateSelection(request);

// 方式二：会话式执行，跳转后必须回读标题确认才放行
const session = createPlanSession(request);
for (let action = session.next(); action; action = session.next()) {
  if (action.type === "navigate") {
    // 点击上一月/下一月按钮：action.direction
  } else if (action.type === "verifyHeader") {
    const actual = readHeaderTitlesFromPage(); // RPA 回读页面标题
    session.confirmTitles(actual);             // 不一致会抛错并终止会话
  } else {
    // 点击日期单元：action.panelIndex / row / column（恒为 inMonth 本月格）
  }
}
```

## 脚本

- `npm run typecheck`：严格类型检查（不产出文件）
- `npm run build`：编译到 `dist/`（含 `.d.ts`，供直接接入）
- `npm test`：编译并运行全部测试
