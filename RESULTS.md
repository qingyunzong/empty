# RESULTS

环境: v22.22.1, 仅标准库, node:test, 离线单机
日期: 2026-10-02T21:34:09Z

## 测试: `node --test`

```
✔ test/cli.test.js (8498.145688ms)
✔ test/lifecycle.test.js (1725.791843ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8940.631237
```

## CLI 演示: `node cli.js examples/events.jsonl examples/final.json`

```
audit_hash=9ff8c00ce901c8cd6b243f552990f592d5e7089124ae10067c05e49e2fadf97f
requests: r1=DISBURSED
failures: 1
```

## 验收标准对照

- 1 双审批通过 → 测试 "1. dual distinct approvals disburse the request" ✔
- 2 同一审批人重复无效 → 测试 "2. duplicate approval by the same person is ineffective" (E_DUPLICATE) ✔
- 3 冻结中审批解冻后生效 → 测试 "3. approval recorded during freeze takes effect after unfreeze" ✔
- 4 放款后撤销报 E_FINAL → 测试 "4. revoke after disbursement fails with E_FINAL" ✔
- 5 随机小部门图与枚举祖先对照 → 测试 "5. random dept DAG: ancestors match transitive-closure enumeration" (50 种子, Warshall 闭包对照) ✔
- JSONL 输入错误 → stderr + 退出码 1 → test/cli.test.js (E_PARSE/E_SCHEMA/E_IO/E_CONFIG/usage) ✔
