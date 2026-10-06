# pbt-lite

一个 TypeScript 属性测试（property-based testing）库，核心保证：

- **独立整数随机状态**：每个属性测试的随机流由 `hashSeed(masterSeed, 属性名)`
  派生，每次运行再由 `mixSeed(propertySeed, runIndex)` 派生。随机状态是单个
  32 位整数（mulberry32），可完整保存与恢复。测试结果**不依赖测试执行顺序**。
- **失败持久化**：失败时把生成参数（masterSeed / propertySeed / runSeed /
  runIndex / size）与完整**缩减轨迹**（每个候选及其是否被接受）写入
  `<failureDir>/<属性名>.json`。
- **真实缩减**：缩减器只在**重新执行属性且仍然失败**时才接受候选；
  通过（或行为不同）的候选一律拒绝并记录在轨迹中。
- **固定小生成器对照**：`fixed.ts` 提供不消耗随机流的确定性小生成器
  （`fixedCycle` / `smallInts` / `smallIntLists`），作为对照组验证随机
  生成 + 缩减得到的反例与确定性枚举的最小反例一致。
- **重放确认**：`replayFailure` 用持久化的整数状态重新生成失败用例、
  重走缩减路径，确认最终反例**仍然失败**。

## 使用

```ts
import { assertProperty, integer, arrayOf } from "./src";

assertProperty(
  "sort is idempotent",
  arrayOf(integer(-100, 100)),
  (xs) => {
    const once = [...xs].sort((a, b) => a - b);
    const twice = [...once].sort((a, b) => a - b);
    return JSON.stringify(once) === JSON.stringify(twice);
  },
  { seed: 1234, runs: 200, failureDir: "pbt-failures" }
);
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行全部测试
```

## 结构

- `src/rng.ts` — 整数状态 PRNG、种子派生（顺序无关的关键）
- `src/gen.ts` — 生成器与玫瑰树缩减（整数 / 数组 / 布尔 / 字符串等）
- `src/fixed.ts` — 固定小生成器（对照组）与确定性枚举
- `src/shrink.ts` — 贪心缩减器：仅接受真实保持失败的候选，记录完整轨迹
- `src/property.ts` — 属性运行器、失败记录持久化
- `src/replay.ts` — 从记录重放并确认最终反例仍失败
