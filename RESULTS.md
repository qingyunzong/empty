# RESULTS

测试环境：Node.js v22.22.1，Linux x86_64。以下为真实运行记录（2026-10-03T04:20Z，`node --test` 全量）。

## `node --test`（TAP 摘要）

```
ok 1 - test/bruteforce.test.js
ok 2 - test/checkpoint.test.js
ok 3 - test/cli.test.js
ok 4 - test/helpers.js
ok 5 - test/incremental.test.js
ok 6 - test/solver.test.js
# tests 6
# pass 6
# fail 0
# duration_ms 15721.0
```

## 验收标准对照

- 验收 1（并列最优字典序确定性）：`test/solver.test.js` → "acceptance 1: tied optimal plans resolve to deterministic lexicographic output"，两次求解计划与证书逐字节一致，并列最优取字典序最小（a→机器0，b→机器1）。PASS
- 验收 2（pin/unpin 增量一致）：`test/incremental.test.js`，15 个随机实例（n=5）逐步 pin/unpin 与全量重算逐一比对 status+plan，另含 insert_job 后 pin 的一致性。PASS
- 验收 3（分叉历史 CONFLICT 定位）：`test/checkpoint.test.js`，注入分叉历史（cp1 后分别 pin a=x / a=y）后 merge 返回 CONFLICT，`divergence.index` 等于分叉前链高，最早分叉边两侧哈希与条目均可定位。PASS
- 验收 4（n≤8 暴力对照）：`test/bruteforce.test.js`，40 个随机实例（n=5）+ 10 个 n=6 单机器实例 + n=8 单参数单机器实例 + 20 个带钉扎实例，求解器与暴力拓扑枚举的 status 与规范计划完全一致。PASS
- 错误 JSON：`INVALID_INPUT`（非法实例/未知命令/非法 pin）、`UNSAT`（内存超限/兼容冲突）、`PENDING`（节点与证书字节预算耗尽，部分证书保留且可 verify）、`CONFLICT`（链分叉），见 `test/cli.test.js` 与 `test/solver.test.js`。PASS
- 证书核验：`makeCertificate` 输出经 `verifyCertificate` 与 `cli.mjs verify` 重放为 VALID；篡改决策条目或计划后判 INVALID。PASS

## 备注

- 测试沙箱禁止进程间 pipe，CLI 测试通过临时文件重定向捕获 stdout（见 `test/cli.test.js` 注释）。
- 曾发现并已修复的缺陷：回溯撤销运行记录时按 (start,end) 匹配，在同区间作业并存时误删内存账本导致不可行计划；已改为按步骤 id 匹配（`src/schedule.js` `unplaceOne`），由验收 4 对照测试捕获。
