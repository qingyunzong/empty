# RESULTS — 结算轨迹合规库与 CLI

- 环境：Node.js v22.22.1，仅标准库（`node:crypto` / `node:fs` / `node:test`），单机离线，空仓库起步
- 运行时间（UTC）：2026-10-02T20:48Z
- 测试命令：`node --test`

## 测试汇总（真实运行结果）

| 测试文件 | tests | pass | fail |
|---|---|---|---|
| test/nfa.test.js | 6 | 6 | 0 |
| test/judge.test.js | 11 | 11 | 0 |
| test/incremental.test.js | 6 | 6 | 0 |
| test/exhaustive.test.js | 1 | 1 | 0 |
| test/proof.test.js | 9 | 9 | 0 |
| test/cli.test.js | 7 | 7 | 0 |
| **合计** | **40** | **40** | **0** |

`node --test` 总耗时约 16s（其中 D 项穷举测试约 11s）。最终运行：`# pass 40 / # fail 0`。

## 验收项对照

- **A 乱序时间拒绝**：`test/judge.test.js`「out-of-order timestamps rejected with TIME_REORDER」通过；CLI 实测 `{"error":"TIME_REORDER"}`，exit=2。
- **B retract 后恢复先前结论**：`test/incremental.test.js`「retract restores the previous conclusion」「retract of a breaking event restores acceptance」通过；retract 后判定结果与先前结论逐字段一致。
- **C 最短失败前缀正确**：`test/judge.test.js`「reject reports earliest failure prefix and all continuations」通过：`[经办, 清算, 归档]` → 前缀 `[经办]`、失败事件 `清算`、可继续事件 `["复核"]`。
- **D ≤6 事件、4 角色全枚举对照**：`test/exhaustive.test.js` 对 3 个流程（线性 / 含环非确定 / 可最小化）各枚举 5461 条日志（4^0…4^6），最小化 DFA 判定 vs NFA 直接模拟（消费长度 / 结论 / 可继续事件三者一致），且逐事件 append 的增量判定 vs 全量重放一致，全部通过。
- **E 篡改 proof 中任一事件 id 验证失败**：`test/proof.test.js` 对 proof 中每个位置的 id 逐一篡改均 `ok:false`；另覆盖篡改 dfaHash / finalState / verdict、跨流程 proof、删除事件 id，验证器均拒绝。

## CLI 实测（`node cli.js judge flow.json log.jsonl [--verify proof.json]`）

| 场景 | 命令输入 | 结果 | exit |
|---|---|---|---|
| 合规日志 | examples/flow.json + examples/log-ok.jsonl | `verdict=accept`，proof 含 dfaHash/eventIds/finalState，输出最短合规路径 `[经办,复核,清算,归档]` | 0 |
| 失败前缀 | examples/log-bad.jsonl（`经办` 后接 `清算`） | `verdict=reject`，prefix=`[e1]`，continuations=`["复核"]` | 1 |
| 时间乱序 | ts 1000 → 999 | `{"error":"TIME_REORDER"}` | 2 |
| 合法 proof | `--verify examples/proof.json` | `verification.ok=true` | 0 |
| 篡改 proof | eventIds[2] 改为 `forged` | `verification.ok=false, reason=EVENT_SEQUENCE` | 3 |

## 错误码

- `NFA_EPSILON_ONLY`：流程含 ε 转移或无任何符号转移（解析阶段拒绝）
- `TIME_REORDER`：日志时间戳非单调不减
- `ID_REUSE`：事件 id 重复
- `CACHE_POISON`：增量会话状态缓存与独立重放不一致（默认每次判定均校验所复用的缓存前缀）
- 规模限制：`LOG_LIMIT`（>1000 事件）、`STATE_LIMIT`（子集构造 >200 状态）

## 机制要点

- NFA → 子集构造（上限 200 状态）→ 划分精化最小化 → BFS 规范重编号 → SHA-256 得 `dfaHash`；同构 DFA 哈希一致（有测试）。
- 接受时输出最小化 DFA 上 BFS 最短合规路径（角色序列 + 状态序列）；拒绝时输出最早失败前缀与当前状态全部可继续角色。
- 增量会话 `Session`：append / retract / replace 后以「事件 id+角色 链式哈希」为键复用前缀状态缓存，每次判定输出 `cache.hitRate`；`verifyCache`（默认开）对所复用前缀从头重放比对，不一致抛 `CACHE_POISON`。60 组 × 40 步随机更正模糊测试中增量结果与全量重放逐字段一致。
- 证明 = `{dfaHash, eventIds, finalState, verdict}`；验证器 `verifyProof(flow, log, proof)` 从 flow 独立重编译、重放、重算哈希，不接触任何 CLI/会话缓存（有缓存污染下的独立性测试）。

## 备注

- 本沙箱禁止 Node 派生子进程（spawnSync EPERM），故 `test/cli.test.js` 通过 `require('../cli').run(argv)` 进程内驱动 CLI 同一入口；上表 CLI 行为另经 bash 直接执行 `node cli.js` 实测确认。
