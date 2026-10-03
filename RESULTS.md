# RESULTS — 真实运行输出

日期: 2026-10-04 00:53:17 CST,Node v22.22.1,平台 Linux 6.6.114.1-microsoft-standard-WSL2 x86_64

## 1. 测试套件: `node --test`

```
TAP version 13
# Subtest: test/evlog.test.js
ok 1 - test/evlog.test.js
  ---
  duration_ms: 1680.536648
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2004.509329
```

## 2. 逐项测试明细: `node test/evlog.test.js`

```
ok 1 - crash point A: append without commit is dropped by recover
ok 2 - crash point B: half-written commit block recovers to last complete commit
ok 3 - crash point C: stale checkpoint is rebuilt from the log
ok 4 - tail enumerates every prefix of a small committed log
ok 5 - second committer on a stale root is rejected with ERR_STALE_ROOT
ok 6 - corrupt checkpoint is rebuilt from the log
ok 7 - recover on empty/missing log is idempotent
ok 8 - verify detects tampering with ERR_CRC
ok 9 - verify rejects forged continuation with ERR_FORK
ok 10 - verify rejects sequence regression with ERR_FORK
ok 11 - verify rejects sequence gap with ERR_SEQ
ok 12 - cli: append/commit/tail/recover round-trip and JSON error on stderr
ok 13 - multiple appends across handles chain and commit together
# tests 13
# pass 13
# fail 0
```

## 3. CLI 实录: `node cli.js ...`(含 recover 演示)

```
$ node cli.js append demo.evlog "kyc-001 approved"
{"ok":true,"seq":1}
$ node cli.js append demo.evlog "kyc-002 approved"
{"ok":true,"seq":2}
$ node cli.js commit demo.evlog
{"ok":true,"lastSeq":2,"root":"610d70c26b034089690d21beb6de9ef98b3e893c9e97493bedc5d0ea2a3fa711","committed":2}
$ node cli.js append demo.evlog "kyc-003 pending (no commit)"
{"ok":true,"seq":3}
$ node cli.js tail demo.evlog   # 只返回已提交
{"ok":true,"entries":[{"seq":1,"payload":"kyc-001 approved","hash":"4acf2a7f7631d29b100e8288f3de0ab8c90c73ab2ea1b585f89d4af1206eb5f0","prevHash":"0000000000000000000000000000000000000000000000000000000000000000"},{"seq":2,"payload":"kyc-002 approved","hash":"610d70c26b034089690d21beb6de9ef98b3e893c9e97493bedc5d0ea2a3fa711","prevHash":"4acf2a7f7631d29b100e8288f3de0ab8c90c73ab2ea1b585f89d4af1206eb5f0"}]}
$ node cli.js recover demo.evlog   # 丢弃未提交
{"ok":true,"lastSeq":2,"root":"610d70c26b034089690d21beb6de9ef98b3e893c9e97493bedc5d0ea2a3fa711","committed":2,"dropped":1,"truncatedBytes":147}
$ node cli.js verify demo.evlog
{"ok":true,"lastSeq":2,"root":"610d70c26b034089690d21beb6de9ef98b3e893c9e97493bedc5d0ea2a3fa711","committed":2,"pending":0}
$ node cli.js tail demo.evlog 1
{"ok":true,"entries":[{"seq":2,"payload":"kyc-002 approved","hash":"610d70c26b034089690d21beb6de9ef98b3e893c9e97493bedc5d0ea2a3fa711","prevHash":"4acf2a7f7631d29b100e8288f3de0ab8c90c73ab2ea1b585f89d4af1206eb5f0"}]}
```

## 验收对照

| 验收项 | 测试 | 结果 |
| --- | --- | --- |
| 1 三类崩溃点恢复确定 | crash point A/B/C | ok 1–3 |
| 2 小日志枚举全部前缀验证 tail | tail enumerates every prefix | ok 4 |
| 3 旧根续写拒绝 ERR_STALE_ROOT | second committer on a stale root | ok 5 |
| 4 检查点损坏从日志重建 | corrupt checkpoint rebuilt | ok 6 |
| 5 空日志 recover 幂等 | recover on empty/missing log | ok 7 |
