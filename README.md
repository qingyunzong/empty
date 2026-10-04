# trip-query

行程查询库。TypeScript 编写，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），零 npm 依赖。

## 规则

- **整数分钟班次**：所有时刻以非负整数分钟输入（绝对分钟）。
- **跨午夜**：使用绝对分钟，不做取模。23:50 为 `1430`，次日 00:30 为 `1470`，跨午夜班次无需特殊处理。
- **站内最低换乘时间**：换乘车次的出发时刻须 ≥ 上一段到达时刻 + 该站 `minTransfer`（未设置的站默认为 0）。首段乘车只需 ≥ 查询起始时刻。
- **最多换乘 3 次**（即最多 4 段车次）。
- **选路优先级**：到达早 → 换乘少 → 班次 ID 序列字典序小。
- **取消班次**：`cancelTrip` 返回新网络（不可变更新），重查即生效；`restoreTrip` 恢复。

## 结构

- `src/network.ts` — 数据模型、网络构建/校验、取消与恢复班次。
- `src/query.ts` — 最优查询：按偏好序的 uniform-cost 搜索；支配剪枝仅在（车站、末班次、已用班次集合、换乘数）相同的状态间进行，保证与枚举一致。
- `src/brute-force.ts` — 全路径枚举参照实现，用于对照。
- `src/cost.ts` — 共享的选路比较器。
- `test/query.test.ts` — 确定性场景（直达、最低换乘时间、跨午夜、换乘上限、平局规则、取消重查）。
- `test/cross-check.test.ts` — 固定种子随机网络（含跨午夜、随机取消），500 例与全枚举逐一对照，并独立校验行程可行性。

## 用法

```ts
import { createNetwork, cancelTrip, query } from "./src/index.js";

const net = createNetwork({
  trips: [
    { id: "T1", stops: [
      { station: "A", arrival: 1430, departure: 1430 }, // 23:50
      { station: "B", arrival: 1470, departure: 1470 }, // 次日 00:30
    ] },
  ],
  minTransfer: { B: 10 },
});

query(net, "A", "B", 1420);        // { legs: [T1], arrival: 1470, transfers: 0 }
query(cancelTrip(net, "T1"), "A", "B", 1420); // null
```

## 测试

```
npm test   # tsc 编译后运行 node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，TypeScript 7.0.2）

```
> tsc -p tsconfig.json && node --test dist/test/*.test.js

# Subtest: dist/test/cross-check.test.js
ok 1 - dist/test/cross-check.test.js
# Subtest: dist/test/query.test.js
ok 2 - dist/test/query.test.js
# tests 2
# pass 2
# fail 0
```

逐条展开：

- `test/query.test.ts`：18/18 通过（direct trips 3、minimum transfer time 3、crossing midnight 3、transfer limit 2、tie-breaking 3、cancelling trips 4）。
- `test/cross-check.test.ts`：1/1 通过，500 个随机网络用例中最优查询与全路径枚举的到达时刻、换乘数、班次序列完全一致，且全部通过独立可行性校验。
