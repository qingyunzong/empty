# rational-tempo-map

有理拍点事件编排库：事件时间以精确有理数拍点存储，tempo 区间映射到有理毫秒，
变速后拍位置不变，仅毫秒投影改变。输出双向映射证书，并与直接积分模型对照。

仅使用 TypeScript + Node.js 内置库（`node:test`、`node:assert`），无第三方依赖。

## 设计

- `src/fraction.ts` — 基于 bigint 的精确有理数（自动约分、符号规范化），
  支持 `"3/4"`、`"1.5"`、`"179.5"` 等输入。
- `src/tempoMap.ts` — 分段恒定 tempo 映射。
  - `beatsToMs(beat)` / `msToBeats(ms)`：两个方向都返回精确 `Fraction`。
  - `setTempo(beat, bpm)` 插入/覆盖 tempo 点；`undo()` 恢复快照，可恢复旧 tempo。
  - `timeline()`：事件按 (拍点, 轨道, ID) 排序并附带精确毫秒。
    映射单调，故拍序即毫秒序。
- `src/certificate.ts` — `buildCertificate(map)` 生成双向映射证书：
  区间表、拍→毫秒→拍 与 毫秒→拍→毫秒 往返校验、以及与直接积分模型的对照。
  积分模型（`integrateBeatsToMs` / `integrateMsToBeats`）为独立 float64 实现，
  按 tempo 区间分段做中点法则数值积分，仅借用区间边界与 bpm，累积全为浮点。

## 使用

```ts
import { TempoMap, buildCertificate } from "./src";

const map = new TempoMap();        // 默认 120 bpm
map.setTempo(4, "179.5");          // 第 4 拍变速
map.addEvent("kick", 1, "15/2");   // 有理拍点事件
map.timeline();                    // [{beat, track, id, ms}...] 按 拍/轨道/ID 排序
map.undo();                        // 撤销变速，恢复旧 tempo
buildCertificate(map);             // 双向映射证书（含积分对照）
```

## 测试

```
npm test     # tsc 构建 + node --test
npm run demo # 打印时间线、undo 结果与完整证书 JSON
```

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
ok 1 - dist/test/certificate.test.js
ok 2 - dist/test/fraction.test.js
ok 3 - dist/test/tempoMap.test.js
# tests 3
# pass 3
# fail 0
```

17 个子测试全部通过：

```
ok 1 - certificate round-trips are exact in both directions
ok 2 - certificate agrees with the direct integration model
ok 3 - integration model matches exact map on a hand-computed case
ok 4 - tempo edit keeps beats, remaps ms, and undo restores old tempo certificate
ok 5 - event at exact segment boundary maps to the segment boundary ms
ok 1 - normalizes sign and gcd
ok 2 - parses fractions, decimals, integers
ok 3 - arithmetic is exact
ok 4 - comparison
ok 5 - rejects zero denominator and division by zero
ok 1 - constant tempo: 120bpm maps one beat to 500ms exactly
ok 2 - tempo change maps intervals to rational ms and keeps beat positions
ok 3 - non-integer bpm still yields rational ms
ok 4 - same-time events order by track then id
ok 5 - undo restores the previous tempo and its mapping
ok 6 - undo of an inserted point removes it
ok 7 - rejects invalid input
```

`npm run demo` 证书中的积分对照实测误差（容差 1e-6）：

- `beats->ms`：maxAbsError ≈ 1.71e-9 ms
- `ms->beats`：maxAbsError ≈ 6.98e-12 拍
