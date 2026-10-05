# rational-tempo

编排（orchestration）事件库：事件时间以**有理数拍点**存储，tempo 区间映射到
**有理毫秒**，变速不改写拍位置，同时间事件按**轨道、ID** 排序，tempo 修改可
**撤销**，并可输出**双向映射证书**与**直接积分模型**对照。纯 TypeScript +
Node.js 内置模块，零第三方依赖。

## 设计

- `src/rational.ts` — BigInt 有理数，永远约分到最简、分母为正，全部运算精确。
- `src/tempo-map.ts` — 分段恒定 tempo 映射。拍是规范时间轴，毫秒是派生值；
  `beatToMs` / `msToBeat` 互为精确逆运算（`msToBeat(beatToMs(b)) === b`）。
  `setTempo` 可撤销：`undo()` 精确恢复旧 tempo 与所有派生毫秒。
- `src/event.ts` / `src/score.ts` — 事件钉在有理拍上，tempo 变化只移动派生毫秒；
  排序为 (beat, track, id) 的全序。
- `src/certificate.ts` — 生成/校验 JSON 证书：段表 + 两个方向的采样点，
  每个采样要求精确往返（beat→ms→beat 与 ms→beat→ms）。证书可 JSON 序列化，
  篡改或 tempo 变更后校验失败，撤销后旧证书重新有效。
- `src/integration.ts` — 直接积分参考模型：对 msPerBeat 做中点法数值积分，
  与精确有理结果对照，验证累积和实现的正确性。

## 使用

```sh
npm test     # 编译 (tsc) 并运行 node --test
npm run demo # 打印时间线、撤销效果、证书与积分对照
```

前置条件：Node.js ≥ 18 与全局可用的 `tsc`（本仓库在 Node v22.22.1 +
TypeScript 7.0.2 下验证）。无 npm 依赖，无需 `npm install`。

```ts
import { Rational } from "./src/rational";
import { TempoMap } from "./src/tempo-map";
import { Score } from "./src/score";

const score = new Score(TempoMap.fromBpm(Rational.of(120))); // 500 ms/拍
score.addEvent({ id: "lead-1", track: 1, beat: Rational.of(3, 2), kind: "note" });
score.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(90)));
score.timeline();   // [{ beat: 3/2, ms: 750, ... }]
score.undoTempo();  // 精确恢复 120 bpm
```

## 实际测试结果

`npm test`（2026-10-05，Node v22.22.1，tsc 7.0.2）：

```
# Subtest: dist/test/certificate.test.js   ok
# Subtest: dist/test/event.test.js         ok
# Subtest: dist/test/integration.test.js   ok
# Subtest: dist/test/rational.test.js      ok
# Subtest: dist/test/tempo-map.test.js     ok
# tests 5
# pass 5
# fail 0
```

`npm run demo` 积分对照摘录（120→90→150 bpm，边界 2、3 拍）：

```
beat 5/2   exact 1333.333333 ms  integrated 1333.333333 ms  relErr 4.84e-12
beat 3     exact 1666.666667 ms  integrated 1666.667500 ms  relErr 5.00e-7
beat 5     exact 2466.666667 ms  integrated 2466.666667 ms  relErr 3.90e-12
```

收敛性测试（边界 1/3 拍，永不与均匀网格对齐）：中点法误差随切片数线性下降
——1k 切片 0.278 ms，400k 切片 6.9e-4 ms，趋向精确有理值 29500/9 ms。
