# ratim — 有理数关键帧动画库

TypeScript 实现，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），无任何 npm 依赖。
关键帧时间为精确有理数（bigint 分子/分母，自动约分），杜绝浮点累积误差。

## 语义定义（区间模型）

**时间映射** `mapTime(mode, t, D)`，把绝对时间 `t` 映射到局部时间（`t < 0` 一律钳到 0）：

- `once`：钳到 `[0, D]`
- `loop`：`t mod D`，值域 `[0, D)`；D 的整数倍精确落在 0
- `pingpong`：`m = t mod 2D`；`m <= D` 时局部为 `m`，否则为 `2D - m`。
  转折点 `m == D` 属于前半程（峰值取到 D），`m == 0/2D` 为谷点 0

**取值**：`Player.value()` 是当前有理数时间的纯函数（分段插值：linear / step /
smooth，按段指定）。因此任意 `seek` 跳时、倒放、大跳跃的结果与直接求值
`Timeline.valueAt(mapTime(...))` 完全一致——测试中以独立浮点模型交叉验证。

**事件跨越**：步进 `a -> b`（`advance`，含负 delta 倒放；`seek` 不触发事件）：

- 前进：展开后的命中时刻 `h` 满足 `a < h <= b` 时触发
- 后退：`b <= h < a` 时触发
- 半开区间保证相邻小步拼接与一次大跳跃的事件序列完全相同，每次跨越恰好触发一次
- 报告方向 = 步进方向 × 局部斜率：`loop` 局部斜率恒为 +1（方向即步进方向）；
  `pingpong` 前半程 +1、后半程 -1；转折点每次经过只发一次
  （峰点 `m == D` 记为 forward 到达，谷点 `m == 0` 记为 backward 到达）
- 同时刻多个事件按定义顺序触发；事件流按行进方向排序

## 使用

```ts
import { Rat, Timeline, Player, smooth } from 'ratim';

const tl = new Timeline([
  { t: Rat.of(0), v: 0, ease: smooth },
  { t: Rat.of(1, 2), v: 10 },   // 关键帧时间：有理数 1/2
  { t: Rat.of(2), v: 30 },
]);
const p = new Player(tl, {
  mode: 'pingpong',
  markers: [{ name: 'hit', t: Rat.of(1) }],
  onEvent: (e) => console.log(e.name, e.at.toString(), e.dir),
});
p.advance(Rat.of(5, 2));  // 前进 2.5，跨周期触发事件
p.advance(Rat.of(-3));    // 倒放
p.seek(Rat.of(100));      // 跳时，不触发事件；value() 与直接求值一致
```

## 测试

```
npm test    # tsc 编译 + node --test
```

测试构成：

- `test/rational.test.ts` — 有理数约分、精确运算、floor/ceil 方向
- `test/timeline.test.ts` — 分段插值、loop/pingpong/once 边界值表
- `test/events.test.ts` — 半开区间、方向翻转、转折点只发一次、小步拼接 == 大跳跃
- `test/fuzz.test.ts` — 确定性种子随机游走：随机时间步 + 大跳跃（最大 5000 个周期）
  对照独立区间模型（逐周期暴力展开的事件模型 + 纯浮点取值模型）

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - dist/test/events.test.js    (11/11)
ok 2 - dist/test/fuzz.test.js      (2/2)
ok 3 - dist/test/rational.test.js  (5/5)
ok 4 - dist/test/timeline.test.js  (7/7)
# tests 4   # pass 4   # fail 0
```

模糊测试日志：`fuzz: 7200 value checks, 6495 event steps, 1693660 crossings verified`
（60 个随机场景 × 120 步，含随机 seek、倒放与跨数千周期的大跳跃，
取值/事件/时间三者均与区间模型逐步一致。）
