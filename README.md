# journey-planner 行程查询库

TypeScript 实现的行程查询库，仅依赖 Node.js 内置模块（运行时为 `node:test` /
`node:assert`，开发期用 `tsc` 编译），无任何第三方运行时依赖。

## 数据模型与规则

- **整数绝对分钟**：所有时间（班次到发、查询出发下限）均为非负整数「绝对分钟」，
  从同一零点起算。跨午夜无需特殊处理：23:55 = `1435`，次日 00:30 = `1470`。
- **班次（Trip）**：`{ id, stops: [{ station, arrival, departure }] }`，
  停靠点 ≥ 2，时间沿行程单调不减（构造时校验，非法数据抛错）。
- **站内最低换乘时间**：下班次后须满足 `后段出发 ≥ 前段到达 + minTransfer(车站)`；
  支持全局默认值 `minTransfer` 与按站覆盖 `stationMinTransfer`；出发站不收取。
- **最多换乘 3 次**：`maxTransfers` 默认 3（即最多乘坐 4 段班次），可配置。
- **选路优先级**：到达时间早 → 换乘次数少 → 班次 ID 序列字典序小；
  仍并列时按各段 `(from, to, depart, arrive)` 字典序作确定性兜底
  （主算法与枚举对照器共用同一比较器 `compareRoutes`）。
- **取消班次**：`cancelTrip(id)` / `restoreTrip(id)` 即时生效，随后 `query` 自动重查。

## 用法

```ts
import { JourneyPlanner } from "./src/planner.js";

const planner = new JourneyPlanner(
  [
    { id: "NIGHT", stops: [
      { station: "A", arrival: 1435, departure: 1435 },  // 23:55
      { station: "B", arrival: 1470, departure: 1470 },  // 次日 00:30
    ]},
    { id: "AFTER", stops: [
      { station: "B", arrival: 1480, departure: 1480 },
      { station: "C", arrival: 1520, departure: 1520 },
    ]},
  ],
  { maxTransfers: 3, minTransfer: 5, stationMinTransfer: { B: 10 } },
);

planner.query("A", "C", 1430);
// => { legs: [NIGHT A→B, AFTER B→C], arrival: 1520, transfers: 1 }

planner.cancelTrip("NIGHT");
planner.query("A", "C", 1430);   // 取消后重查 => null
```

## 实现要点

- `src/planner.ts`：标签设定式 Dijkstra。优先队列按
  `(当前时间, 已乘段数, 段序列字典序)` 出队，首次弹出目的地即为最优；
  同站标签剪枝要求占优标签「不更晚 且（换乘严格更少 或 换乘相同且段序列字典序更小）」，
  保证班次 ID 序决胜的正确性。
- `src/enumerate.ts`：全路径枚举对照器（DFS 枚举所有 ≤ 上限换乘的可行行程，
  用同一比较器取最优），用于交叉验证主算法。

## 测试

```sh
npm test        # tsc 编译 + node --test 运行全部测试
npm run typecheck
```

### 实际结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
ok 1 - 基本直达查询：按绝对分钟返回最早到达
ok 2 - 换乘须满足站内最低时间（全局与按站覆盖）
ok 3 - 边界值：出发/换乘时间恰好等于下限即允许
ok 4 - 跨午夜使用绝对分钟：1435 -> 1470，不会被次日凌晨 30 分混淆
ok 5 - 最多换乘 3 次：恰好 3 次可达，需要 4 次则不可达
ok 6 - 选路优先级：到达早 > 换乘少 > 班次 ID 序
ok 7 - 取消班次后重查：结果同步更新，可恢复
ok 8 - 输入校验：非整数分钟、时间不单调、重复 ID 均报错
ok 9 - 随机网络与全路径枚举对照：取消班次前后多轮查询
# tests 9
# pass 9
# fail 0
随机对照完成：3000 次查询全部一致，其中 2296 次可达
```

随机对照：固定种子（mulberry32，20261006 起）生成 500 个随机网络
（4–6 车站、6–14 班次、2–5 停靠点、时间 0–1900 绝对分钟、全局换乘 0–10 分钟、
30% 车站带 0–15 分钟覆盖、换乘上限 2–4），每个网络在取消 0–3 个班次前后
各执行 3 次随机查询，主算法结果与全路径枚举逐一深比较（共 3000 次），
并对每条结果独立校验可行性（班次有效、段连续、换乘时间达标、换乘数不超限）。
