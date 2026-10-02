# RESULTS

测试命令：`node --test`（npm test）
环境：Node.js v22.22.1，Linux/x86_64，单机离线，仅标准库
记录时间：2026-10-03 02:13:52 CST

## 汇总（真实运行输出）

```
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3859.647041
```

## 分文件结果（node --test --test-reporter=spec）

| 测试文件 | 结果 | 耗时(ms) | 覆盖验收点 |
|---|---|---|---|
| test/cip.test.js | ✔ pass | 3559.42 | 2) CIP 边界重归属（含失败 CIP、撤回重归属、REJECT→HOLD 回滚） |
| test/cli.test.js | ✔ pass | 2610.78 | CLI 四产物（batches/transitions/comp/late.log）、VOL_INVALID、迟到 lab |
| test/density.test.js | ✔ pass | 4041.59 | 4) 重量体积矛盾保持 REJECT、lab 不可翻转、密度边界值 |
| test/enumeration.test.js | ✔ pass | 4811.41 | 3) ≤6 事件全枚举（55986 条序列）对照独立状态机 + 单调审计不变量 |
| test/lab-retract.test.js | ✔ pass | 2186.73 | 1) lab 撤回安全回滚 RELEASE→HOLD + 补偿记录 |

## 验收对照

1. **lab 撤回安全回滚**：test/lab-retract.test.js — RELEASE→HOLD，comp.jsonl 输出
   `RETRACT_ROLLBACK` 补偿，审计链 EMPTY→HOLD→RELEASE→HOLD 仅追加、seq 单调。通过。
2. **CIP 边界重归属**：test/cip.test.js — 撤回失败 CIP 后跨边界 fill 重新归属，
   REJECT(CIP_WINDOW)→HOLD 并产生补偿；fill 必须落在最近 ok CIP 之后到下次 CIP 前。通过。
3. **枚举 ≤6 事件对照状态机**：test/enumeration.test.js — 6 符号字母表、长度 1..6 共
   55986 条序列，引擎终态与独立参考模型逐条一致；校验 seq 单调、lab 不得从 REJECT 翻转、
   未决(HOLD)不等于不可满足(REJECT)。通过。
4. **重量体积矛盾保持 REJECT**：test/density.test.js — 密度 0.2 g/mL 的 fill 进入
   REJECT(DENSITY_MISMATCH)，后续 lab pass 到达后终态仍为 REJECT；仅撤回肇事 fill 可恢复。通过。

补充：`vol <= 0` 报 `VOL_INVALID`（test/density.test.js 与 CLI 端到端均覆盖）；
缺 lab 批次固定 HOLD；迟到 lab 记录 late.log 且可改 HOLD 为 RELEASE。
