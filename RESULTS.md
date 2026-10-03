# RESULTS

结算轨迹合规库与 CLI — 真实运行结果。

- 环境：Node.js v22.22.1，仅标准库（`node:test` / `node:crypto` / `node:fs`），单机离线，无第三方依赖。
- 规模限制：日志 ≤ 1000 事件（`LOG_LIMIT`），子集构造 ≤ 200 DFA 状态（`STATE_LIMIT`）。

## 测试（`node --test`，2026-10-04 实跑）

```
ok 1 - test/cli.test.js
ok 2 - test/compliance.test.js
ok 3 - test/enumerate.test.js
# tests 3
# pass 3
# fail 0
# duration_ms 17774.241687
```

逐条子测试（全部通过）：

```
test/compliance.test.js
ok 1 - accept: shortest compliant path is returned with a verifiable proof
ok 2 - A: out-of-order timestamps are rejected with TIME_REORDER
ok 3 - duplicate event ids are rejected with ID_REUSE
ok 4 - epsilon-only NFA is rejected with NFA_EPSILON_ONLY
ok 5 - C: earliest failure prefix and continuations are exact
ok 6 - B: retract and replace restore earlier conclusions and match full replay
ok 7 - incremental session always agrees with full replay under random corrections
ok 8 - cache poisoning is detected and reported as CACHE_POISON
ok 9 - E: tampering any proof event id (or any other field) fails verification
ok 10 - reject proofs verify independently as well
ok 11 - minimized DFA hash is canonical and independent of state naming
ok 12 - nondeterministic NFA with epsilon transitions compiles correctly
test/enumerate.test.js
ok 1 - D: exhaustive logs (<=6 events, 4 roles) — DFA matches NFA simulation and incremental matches full replay
test/cli.test.js
ok 1 - CLI judge accepts a compliant log and exits 0
ok 2 - CLI judge rejects with prefix and continuations, exit 1
ok 3 - CLI proof round-trip: --proof writes, --verify validates; tampering fails
ok 4 - CLI reports TIME_REORDER with exit code 2
ok 5 - CLI reports NFA_EPSILON_ONLY with exit code 2
```

## 验收项对照

- A 乱序时间拒绝：`test/compliance.test.js` 子测试 2 + `test/cli.test.js` 子测试 4，错误码 `TIME_REORDER`，CLI 退出码 2。
- B retract 后恢复先前结论：子测试 6（retract/replace 后逐字段恢复先前结论并与全量重放一致）+ 子测试 7（400 次随机 append/retract/replace，增量结果与全量重放逐步深比较），并输出缓存命中率（`cache.hitRate`）。
- C 最短失败前缀：子测试 5，失败前缀含首个不可消费事件，`continuations` 为最后有效状态的全部可继续角色。
- D 全量枚举对照：`test/enumerate.test.js`，2 个流程（确定性线性 / 含 ε 的非确定 NFA）× 4 角色 × 长度 0–6 共 5461 条日志/流程，编译后最小化 DFA 与 NFA 参考模拟逐条对照（verdict、消费数、可继续角色、前缀长度），并逐事件增量判定对照全量重放。
- E 篡改 proof 失败：子测试 9，逐一篡改 `eventIds` 中每个事件 id（及 `finalState`/`verdict`/`dfaHash`）均验证失败；验证器由 `flow.json` 独立重编译最小化 DFA 并重放，不读取任何 CLI/会话缓存。

## CLI 实跑（`node cli.js judge flow.json log.jsonl [--proof out.json] [--verify proof.json]`）

```
judge exit=0            # examples/flow.json + examples/log.jsonl，verdict=accept
verify exit=0           # --verify proof.json，verification.ok=true
tampered exit=1         # 篡改 proof.eventIds[1]，verification={"ok":false,"reason":"EVENT_SEQUENCE_MISMATCH"}
reorder exit=2          # 乱序时间日志，stderr: {"error":"TIME_REORDER", ...}
```

接受时输出示例（节选）：`path=["m0","m1","m2","m3","m3"]`，
`proof.dfaHash="sha256:092a5e2deeb5df08fff93cc2f826ab29a77e0ef90fe1e58790f397f642476273"`，
`proof.eventIds=["e1","e2","e3","e4"]`，`proof.finalState="m3"`。

## 设计要点

- `src/nfa.js`：NFA JSON 转移表校验（`role` 标记或 `epsilon:true`）、ε-闭包、子集构造、划分细化最小化、BFS 规范重命名后的 SHA-256 哈希（与状态命名无关）；`simulateNfa` 为参考模拟器。
- `src/judge.js`：日志校验（`ID_REUSE` / `TIME_REORDER`）、确定性重放（接受时路径即唯一最短合规路径）、`IncrementalSession` 增量重判——缓存以前缀链式指纹 `fp_k = H(fp_{k-1}:H(event_k))` 防护，任何位置更正自动失效后续缓存；指纹匹配但状态非法时抛 `CACHE_POISON`。
- `src/proof.js`：证书含最小化 DFA 哈希、消费的事件 id 序列、最终状态与 verdict；验证器独立重算并核实拒绝的真实性（`PREMATURE_REJECT` 防护）。
- 错误码：`NFA_EPSILON_ONLY`、`TIME_REORDER`、`ID_REUSE`、`CACHE_POISON`（另有限额类 `LOG_LIMIT` / `STATE_LIMIT` 与输入类 `INVALID_NFA` / `INVALID_EVENT`）。
