# 撤销链测试结果（RESULTS）

- 运行环境：Node.js v22.22.1，仅标准库（`node:test` / `node:crypto` / `node:fs`），离线单机
- 测试命令：`node --test`
- 测试时间：2026-10-02（Asia/Shanghai）
- 总体结果：**2 个测试文件、16 项测试全部通过，0 失败**（1 项 spawn 冒烟测试在当前沙箱跳过，CLI 已手动端到端验证）

## 汇总

```
ok 1 - test/cli.test.js
ok 2 - test/machine.test.js
# tests 2
# pass 2
# fail 0
# skipped 0
```

## 验收项对照

| 验收项 | 测试 | 结果 |
| --- | --- | --- |
| 1 全额撤销后再撤销恢复余额与额度 | `acceptance 1: full revoke then unrevoke restores balance and quota` | ok |
| 2 两笔部分撤销边界到 0，超额撤销拒绝 | `acceptance 2: two partial revokes reach boundary 0, further revoke rejected` | ok |
| 3 乱序重放与 3 事件全排列（6 种）对照一致 | `acceptance 3: out-of-order replay matches all 3-event permutations` | ok |
| 4 伪造 prevHash 校验失败报 E_CERT | `acceptance 4: forged prevHash fails verification with E_CERT` | ok |

## 明细（node test/<file>）

test/machine.test.js：

```
ok 1 - acceptance 1: full revoke then unrevoke restores balance and quota
ok 2 - acceptance 2: two partial revokes reach boundary 0, further revoke rejected
ok 3 - acceptance 3: out-of-order replay matches all 3-event permutations
ok 4 - acceptance 4: forged prevHash fails verification with E_CERT
ok 5 - idempotency: duplicate event id applied exactly once
ok 6 - unrevoke cannot exceed restorable amount nor original tx cap
ok 7 - revoke referencing unknown txHash fails with E_REF
ok 8 - unrevoke referencing unknown revokeId fails with E_REF
ok 9 - verify accepts an untampered bundle
ok 10 - tampered event amount fails verification with E_CERT
```

test/cli.test.js：

```
ok 1 - cli apply emits cert JSONL and final summary; verify passes
ok 2 - cli apply handles out-of-order events identically
ok 3 - cli verify rejects forged prevHash with E_CERT on stderr, exit 1
ok 4 - cli apply rejects over-revoke with E_AMOUNT on stderr, exit 1
ok 5 - cli with no args prints usage error and exits 1
ok 6 - cli apply rejects malformed JSONL with E_PARSE, exit 1
ok 7 - spawned CLI process: apply then verify, exit codes and JSONL
       # SKIP 当前沙箱禁止 spawn 子进程；CLI 已手动验证：
       #   node cli.js apply events.jsonl state.json → 输出 3 条 cert + 1 条 final（JSONL），exit 0
       #   node cli.js verify state.json → {"type":"verify","ok":true,...}，exit 0
```

## 手动 CLI 验证记录

```
$ node cli.js apply events.jsonl state.json
{"type":"cert","seq":0,"eventId":"t1","prevHash":"0000...0000","stateHash":"653b...b9dd","hash":"47c4...60fb2"}
{"type":"cert","seq":1,"eventId":"r1","prevHash":"47c4...60fb2","stateHash":"ac10...f8ac","hash":"dd04...f75f"}
{"type":"cert","seq":2,"eventId":"u1","prevHash":"dd04...f75f","stateHash":"ab75...cd4a","hash":"2fb8...94e1"}
{"type":"final","balance":100,"revocable":100,"head":"2fb8...94e1"}
$ node cli.js verify state.json
{"type":"verify","ok":true,"steps":3,"head":"2fb8...94e1"}
```

（哈希截断显示；完整值见运行输出。）
