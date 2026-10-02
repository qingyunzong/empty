# 贸易融资托管账户放款判定 — 测试结果

运行环境:Node.js 22,仅标准库,`node:test`,离线单机。

## 结构

- `src/ledger.js` — 核心库:`DepartmentGraph`(部门 DAG 祖先闭包)、`Ledger`(状态机 + 审计哈希链)。
- `cli.js` — CLI:`node cli.js events.jsonl final.json`。
- `test/ledger.test.js` — 状态机与属性测试;`test/cli.test.js` — CLI 测试(进程内调用 `main`,因沙箱禁止 spawn)。
- `examples/events.jsonl` / `examples/final.json` — 端到端示例。

## 机制要点

- 状态机:`PENDING → DISBURSED`(两名不同审批人 allow 生效)、`PENDING → REJECTED`(任一 deny 生效);冻结为正交标志。
- 冲突优先级:合规冻结 > deny > allow。冻结期间审批仅记录(`effective: false`),解冻后按原始 `(ts, seq)` 顺序生效并重估。
- 审批权沿部门 DAG 向下继承:审批人部门须为请求部门的祖先(含自身)。
- 撤销仅本人或上级(审批人部门的严格祖先)可在放款前执行;放款后撤销报 `E_FINAL`。
- 审计哈希:`hash_i = sha256(hash_{i-1} + canonical(event) + canonical(result))`,逐事件链式,终态输出 `auditHash`。
- 错误分级:业务规则失败(`E_DUPLICATE`/`E_AUTHORITY`/`E_FINAL`/`E_STATE`/`E_NOT_FOUND`)记入 transitions 并打印 stderr,退出码 0;结构性错误(解析失败、未知请求/部门/成员、缺字段)打印 stderr,退出码 1。

## 验收对照

| # | 验收标准 | 测试 | 结果 |
|---|----------|------|------|
| 1 | 双审批通过 | `1. dual approval by distinct authorized approvers disburses` | PASS |
| 2 | 同一审批人重复无效 | `2. duplicate approval by the same approver is invalid`(E_DUPLICATE) | PASS |
| 3 | 冻结中审批解冻后生效 | `3. approvals during freeze are recorded and take effect after unfreeze` | PASS |
| 4 | 放款后撤销报 E_FINAL | `4. revoke after disbursement reports E_FINAL` | PASS |
| 5 | 随机小部门图与枚举祖先对照 | `5. random department DAGs: ancestors match brute-force enumeration`(200 组随机 DAG,BFS 闭包 vs 不动点枚举) | PASS |

## 测试输出(`node --test`)

```
ok 1 - test/cli.test.js
ok 2 - test/ledger.test.js
# tests 2
# pass 2
# fail 0
```

`test/ledger.test.js` 明细:

```
ok 1 - 1. dual approval by distinct authorized approvers disburses
ok 2 - 1b. audit hash is deterministic for identical event streams
ok 3 - 1c. approval authority inherits down the department DAG
ok 4 - 2. duplicate approval by the same approver is invalid
ok 5 - 3. approvals during freeze are recorded and take effect after unfreeze
ok 6 - 3b. conflict priority: freeze gates, then deny beats allow
ok 7 - 3c. freeze requires compliance role
ok 8 - 4. revoke after disbursement reports E_FINAL
ok 9 - 4b. revoke before disbursement allowed for self and superior only
ok 10 - 5. random department DAGs: ancestors match brute-force enumeration
```

`test/cli.test.js` 明细:

```
ok 1 - cli: processes JSONL scenario and writes final.json
ok 2 - cli: malformed JSON line exits 1 with E_PARSE on stderr
ok 3 - cli: structural error (unknown request) exits 1
ok 4 - cli: missing input file exits 1 with E_IO
ok 5 - cli: missing usage args exits 1
ok 6 - cli: output is deterministic across runs
```

合计 16 项测试全部通过。

## CLI 端到端示例

`node cli.js examples/events.jsonl examples/final.json`(退出码 0,stderr 报告业务失败):

```
line 12: E_AUTHORITY: approver erin (dept ops) has no authority over dept trade-asia
line 14: E_DUPLICATE: approver bob already approved request R1
line 18: E_FINAL: request R1 already disbursed; cannot revoke
```

关键迁移轨迹(`examples/final.json` 的 transitions):

```
submit    -> PENDING
approve   FAIL E_AUTHORITY   (erin 无审批权)
approve   PENDING->PENDING   (bob,第 1 人会签)
approve   FAIL E_DUPLICATE   (bob 重复审批无效)
freeze    PENDING->PENDING   (合规冻结)
approve   PENDING->PENDING   (dave,冻结中仅记录 effective:false)
unfreeze  PENDING->DISBURSED (解冻后按原时间生效,双人会签达成)
revoke    FAIL E_FINAL       (放款后不可撤销)
```

终态:`R1 = DISBURSED`,`auditHash = db86b45370a55cced06b7a205c32650fa553f5f8dac769658afcbcde5dcda201`(相同事件流重放结果逐字节一致,见 CLI 确定性测试)。
