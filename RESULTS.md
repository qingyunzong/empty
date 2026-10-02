# RESULTS

- 日期: 2026-10-03
- 环境: Node.js v22.22.1,仅标准库,离线单机
- 测试命令: `node --test`(退出码 0)

## 汇总(真实输出,`node --test --test-reporter=spec`)

```
✔ test/cli.test.js (5248.698324ms)
✔ test/conflict.test.js (5460.759027ms)
✔ test/cycle.test.js (1353.43287ms)
✔ test/inheritance.test.js (1678.699743ms)
✔ test/random-graph.test.js (2213.565815ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5657.55504
```

`node --test`(TAP)汇总:`# tests 5 / # pass 5 / # fail 0`,进程退出码 0。

## 子测试明细(逐文件真实输出)

```
== test/cli.test.js
ok 1 - CLI writes decisions.jsonl and a verifiable audit.json hash chain
ok 2 - CLI reports malformed JSONL line as {error:{code,line}} on stderr, exit 1
ok 3 - CLI reports E_CYCLE from policy file with line number
ok 4 - CLI reports schema errors in events with line number
ok 5 - CLI works as a real subprocess: node cli.js policy.jsonl events.jsonl out/ # SKIP sandbox blocks child processes
== test/conflict.test.js
ok 1 - explicit deny beats allow even when the allow is on a nearer ancestor
ok 2 - nearer ancestor wins among rules of the same effect
ok 3 - tied rules (same role, same distance, same effect) break by rule id lexicographic
ok 4 - deny beats allow on the same role; wildcard patterns compete with exact rules
ok 5 - default deny when nothing matches
== test/cycle.test.js
ok 1 - two-role cycle reports E_CYCLE at the line that closes the loop
ok 2 - self-inheritance reports E_CYCLE
ok 3 - longer cycle through multiple roles reports E_CYCLE
ok 4 - diamond inheritance is a DAG, not a cycle
== test/inheritance.test.js
ok 1 - inherited rule applies through the full chain with inheritance path
ok 2 - revocation: authorization before revoke time still allowed (history immutable)
ok 3 - revocation: authorization at/after revoke time denied
ok 4 - revoking an ancestor removes only its inherited rules after the revoke time
== test/random-graph.test.js
ok 1 - random DAGs: ancestors and shortest distances match brute-force path enumeration
```

合计 19 个子测试:18 通过,1 跳过。跳过的是真实子进程冒烟测试
(`spawnSync node cli.js ...`):当前沙箱禁止派生子进程(EPERM),测试检测
到 `EPERM` 后标记 SKIP;在无沙箱环境中它会真实执行 `node cli.js` 并校验
输出文件。CLI 的全部行为(含退出码与 stderr 错误 JSON)已由前 4 个子测试
通过注入式入口 `require('./cli').run(argv, deps)` 在进程内完整覆盖。

## 验收点对照

1. 继承链 + 撤销前后对照 → `test/inheritance.test.js`(4 项,全过)
2. 同资源 allow/deny 冲突与并列规则 tie-break → `test/conflict.test.js`(5 项,全过)
3. 随机小图对照独立枚举全部祖先路径 → `test/random-graph.test.js`(200 个随机 DAG,种子 20261003,全过)
4. 循环继承报 E_CYCLE → `test/cycle.test.js`(4 项,全过)+ `test/cli.test.js` 第 3 项(CLI 层)

## CLI 端到端示例(真实运行)

```
$ node cli.js /tmp/demo2/policy.jsonl /tmp/demo2/events.jsonl /tmp/demo2/out   # exit=0
$ cat /tmp/demo2/out/decisions.jsonl
{"id":"e1","role":"auditor","resource":"merchant:42","at":"2026-01-10T09:00:00Z","decision":"allow","rule":"r-allow-merchant","path":["auditor","senior","base"],"reason":"allowed by rule r-allow-merchant"}
{"id":"e2","role":"auditor","resource":"merchant:9","at":"2026-01-10T09:05:00Z","decision":"deny","rule":"r-deny-frozen","path":["auditor","senior"],"reason":"deny rule r-deny-frozen overrides allow (explicit deny wins)","conflicts":["r-allow-merchant"]}
{"id":"e3","role":"auditor","resource":"merchant:42","at":"2026-02-10T09:00:00Z","decision":"deny","rule":null,"path":[],"reason":"role_revoked"}
$ head -4 /tmp/demo2/out/audit.json
{
  "algorithm": "sha256-chain",
  "genesis": "0000000000000000000000000000000000000000000000000000000000000000",
  "count": 3,
```

错误路径示例(真实运行):策略第 2 行非法 JSON → stderr 输出
`{"error":{"code":"E_PARSE","line":2}}`,退出码 1,不生成输出文件。
