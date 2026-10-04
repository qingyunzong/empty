# 审计抽样库与 CLI — 结果

基线：Node.js v22.22.1，仅标准库，`node:test`，单机离线，无第三方依赖。

## 架构

- `src/regex.js` — 流程正则解析（字面量、连接、`|`、`*`、`+`、`?`、`ε`、`∅`、括号；事件名以空白/运算符分隔），Brzozowski 导数独立匹配器
- `src/automata.js` — Thompson NFA → 子集构造 DFA → 划分细化最小化 → BFS 规范重编号；`compileFlow` 产出最小 DFA
- `src/audit.js` — 日志检查、最短状态路径见证、最小编辑距离修复（仅插入/删除，替换=删+插代价 2），0-1 BFS 求距离 + 最短路 DAG 上按（事件名， 操作）字典序枚举全部并列方案，上限 10 条
- `src/equiv.js` — 积自动机 BFS 等价判定与最短区分见证；独立枚举器（按长度+字典序逐串枚举、仅用导数匹配）复现见证
- `cli.js` — `node cli.js check flow.re log.jsonl [--k N]` / `node cli.js equiv a.re b.re`

规模限制：日志 ≤ 200 事件（`LOG_TOO_LONG`），K ≤ 6。错误码：`EMPTY_ALPHABET`、`LOG_TOO_LONG`、`NO_REPAIR_WITHIN_K`、`NONTERM_AUTOMATON`。

## 测试结果（node --test，真实输出）

```
ok 1 - A: legal flow accepted, witness path replays to an accepting state
ok 2 - B: missing 复核 yields an insert repair
ok 3 - C: all tied optimal repairs are listed
ok 4 - C2: substitution costs delete+insert (2), ties capped at 10 plans
ok 5 - repairs are replayable: applying a plan makes the log accepted
ok 6 - repair plans are capped at 10 even with more ties
ok 7 - D: exhaustive enumeration len<=7 over 5 events, DFA == derivative matcher
ok 8 - E: repair beyond K=6 reports NO_REPAIR_WITHIN_K
ok 9 - edge: empty log accepted iff regex accepts empty string
ok 10 - edge: unknown event rejected immediately
ok 11 - edge: 冲正 cannot undo a non-posted entry
ok 12 - error: LOG_TOO_LONG beyond 200 events
ok 13 - error: EMPTY_ALPHABET for regex without events
ok 14 - error: NONTERM_AUTOMATON for empty language
ok 15 - equiv: equivalent flows, and distinguishing witness reproduced by enumerator
ok 16 - CLI: check and equiv end-to-end (in-process main)
ok 17 - CLI: error codes surface
# tests 17
# pass 17
# fail 0
```

验收对照：

- **A** 合法流程 `申请 复核 放行 入账` 通过；见证为状态序列 `[0,1,2,3,4]`，测试将其沿最小 DFA 逐步重放并断言终点为接受态。
- **B** 日志 `[申请,放行,入账]` 拒绝，修复 `[{insert 复核 at 1}]`，minCost=1。
- **C** 流程 `申请 (复核|放行) 入账`、日志 `[申请,入账]`：并列最优两条（插入复核 / 插入放行）全部列出；另有 20 条并列时截断为 10 条且按事件名字典序。
- **D** 流程 `申请 复核* 放行? 入账 (冲正 入账?)*`，对 5 种事件、长度 ≤7 的全部 97656 个串逐一比对最小 DFA 与导数匹配器，全部一致。
- **E** 日志 7×`放行`（minCost=9 > K=6）输出 `NO_REPAIR_WITHIN_K`，而非不可满足。

## CLI 实测输出

`node cli.js check examples/flow.re examples/log-ok.jsonl` →

```json
{
  "accept": true,
  "witness": { "states": [0, 1, 2, 3, 4], "events": ["申请", "复核", "放行", "入账"] },
  "repairs": []
}
```

`node cli.js check examples/flow.re examples/log-missing-review.jsonl` →

```json
{
  "accept": false,
  "witness": { "states": [0, 1], "events": ["申请"], "failedAt": 1, "event": "放行" },
  "repairs": [[{ "op": "insert", "event": "复核", "at": 1 }]],
  "minCost": 1
}
```

`node cli.js equiv examples/flow-a.re examples/flow-b.re`（`申请 (复核 申请)*` vs `(申请 复核)* 申请`）→

```json
{ "equiv": true, "witness": null, "reproduced": null }
```

`node cli.js equiv examples/flow.re examples/flow-strict.re`（后者允许多一个末尾冲正）→

```json
{
  "equiv": false,
  "witness": ["申请", "复核", "放行", "入账", "冲正"],
  "reproduced": true
}
```

`node cli.js check` 对 7×`放行` 日志 → `{"accept":false, ..., "error":"NO_REPAIR_WITHIN_K", "minCost":9}`，退出码 1。
对空字母表流程 `ε*` → `{"error":"EMPTY_ALPHABET"}`，退出码 2。

## 边界语义

- 空日志仅当正则接受空串时通过（如 `申请?` 接受，`申请` 拒绝并给出 4 步插入修复）。
- 未知事件（非申请/复核/放行/入账/冲正）立即拒绝，`reason.reason = "UNKNOWN_EVENT"`。
- 冲正前面没有未冲销的入账时立即拒绝，`reason.reason = "REVERSAL_WITHOUT_POSTING"`。
- 修复算子仅插入/删除，替换自然表现为删除+插入（代价 2）。
