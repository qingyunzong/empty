# rational-tempo-sequencer

音序器 tick ↔ 微秒转换库：分段有理数速度表，每段精确积分，最后统一做一次
最近偶数舍入（round-half-even）。编辑速度段不会移动事件 tick。

## 核心概念

- `Rational`：BigInt 精确有理数，自动约分、规范符号，`roundHalfEven()` 实现最近偶数舍入。
- `TempoMap`：分段恒定速度表，每段携带有理数 `usPerTick`（微秒/tick）。
  - `tickToRational(tick)`：对 `[0, tick)` 做精确有理数积分，不舍入。
  - `tickToUs(tick)`：精确积分后统一做一次最近偶数舍入，返回 `bigint`。
  - `usToTick(us)`：反向定位——返回舍入时间最早 `>= us` 的 tick（二分查找，
    速率为正保证舍入时间单调不减）。
  - `setTempo(tick, rate)` / `removeTempo(tick)`：编辑分段；tick 0 段不可删除。
- `Sequencer`：事件只存整数 tick，微秒位置随时从 `TempoMap` 派生，
  因此编辑速度段只改变派生时间，事件 tick 不变。

## 示例

```ts
import { TempoMap, Rational } from "rational-tempo-sequencer";

const map = new TempoMap(Rational.of(1n, 2n)); // 0.5 µs/tick
map.setTempo(100, Rational.of(1000n, 3n));     // 第 100 tick 起 333.33… µs/tick

map.tickToUs(200);        // 精确积分后一次舍入
map.usToTick(50_000n);    // 最早达到 50000 µs 的 tick
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

测试用独立的朴素有理数参考实现（`test/reference.ts`，逐 tick 累加）交叉验证：
单调性、分段边界连续性、反向定位的最早性，以及"只在末尾舍入一次"的语义。
