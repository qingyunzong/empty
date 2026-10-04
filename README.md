# ranking-engine

按比赛事件计算积分的排名库（TypeScript，仅使用 Node.js 内置模块，零运行时依赖）。

## 规则

- **积分**：胜 3 / 平 1 / 负 0（可通过 `PointsConfig` 配置）。
- **排名**：联赛积分降序；同分球队按以下规则递归决胜：
  1. 相互战绩小联赛积分（只统计同分球队之间的比赛）
  2. 小联赛净胜分
  3. 球队 ID 升序

  每条规则若能把同分组拆小，则对仍同分的子组递归应用同一套规则；
  若规则无任何进展（无法拆分），直接回退到球队 ID。
- 取消的场次不计入任何统计；没有有效场次的球队不出现在排名中。

## 增量重算与核对

事件日志（`result` / `cancel` / `correct`）是唯一事实源，追加在
`RankingEngine` 内。取消场次或更正结果时，只对两支受影响球队的缓存
聚合做增量 delta 调整（`played === 0` 的球队会被移除），名次在读取时
由缓存聚合并经决胜规则重排，无需重扫历史。

`verifyAgainstFullRecompute()` 通过独立代码路径完整重放事件日志
（先折叠出有效场次集，再逐场累加统计），比对场次集、各队统计与最终
排名三者是否一致。模糊测试在每次随机操作后都执行该核对。

## API

```ts
import { RankingEngine } from "./src/engine.js";

const engine = new RankingEngine();
engine.recordResult("m1", "A", "B", 3, 1);   // 录入结果
engine.cancelMatch("m2");                     // 取消场次 -> 重算受影响名次
engine.correctResult("m1", 1, 3);             // 更正结果 -> 重算受影响名次
engine.getStandings();                        // StandingEntry[]（含 rank）
engine.verifyAgainstFullRecompute();          // 与完整重算核对 -> boolean
```

## 运行

```sh
npm test           # tsc 构建到 dist/ 后用 node:test 跑测试
npm run typecheck  # tsc --noEmit 严格类型检查
```

## 实际运行结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），2026-10-05。
注：本机 Node 构建未启用类型擦除（`ERR_NO_TYPESCRIPT`），故测试经
`tsc` 编译为 JS 后运行。

`npm run typecheck`：通过，无错误。

`npm test` 输出（TAP 摘要）：

```
# Subtest: dist/test/engine.test.js
ok 1 - dist/test/engine.test.js
# Subtest: dist/test/fuzz.test.js
ok 2 - dist/test/fuzz.test.js
# Subtest: dist/test/tiebreak.test.js
ok 3 - dist/test/tiebreak.test.js
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# duration_ms 1082.883036
```

各文件明细（`--test-reporter=spec`）：共 16 个用例全部通过 ——

- `engine.test.js`：5/5 通过（积分统计、非法输入、取消重算、更正重算、
  取消+重录+更正组合）
- `tiebreak.test.js`：6/6 通过（小联赛积分、净胜分破循环、三队循环、
  无进展回退 ID、递归子组回退 ID、子组独立小联赛重估）
- `fuzz.test.js`：5/5 通过（5 个种子 × 400 次随机 录入/取消/更正，
  每步均与完整重算核对一致，且事件日志可完整重放复现最终排名）
