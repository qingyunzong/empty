# RESULTS

- 环境: Node.js v22.22.1（仅标准库，node:test，离线单机）
- 日期: 2026-10-02T17:47:15Z
- 命令: `node --test`

## 验收对照

| # | 验收项 | 测试 | 结果 |
|---|--------|------|------|
| 1 | 继承可读汇总通过 | 1. inherited read access makes aggregate build and verify pass | PASS |
| 2 | 一个来源 deny 失败并列最小集合 | 2. deny on one source fails with minimal over-privilege set / 2b. deny wins over allow | PASS |
| 3 | 脱敏版本不匹配报 E_MASK | 3. mask version mismatch raises E_MASK | PASS |
| 4 | 撤销脱敏后旧报表 verify 通过、新签发失败 | 4. revoked mask: old report still verifies, new build fails | PASS |
| 5 | 小图枚举闭包对照 | 5. closure matches brute-force enumeration on small graph | PASS |
| - | CLI build/verify 往返 | cli build then verify round-trip succeeds | PASS |
| - | CLI deny 退出码 1 + stderr 最小集合 | cli deny exits 1 with minimal set on stderr | PASS |
| - | CLI 篡改报表 verify 失败 E_HASH | cli verify rejects tampered report with exit 1 | PASS |
| - | CLI 版本不匹配退出码 1 + E_MASK | cli mask version mismatch exits 1 with E_MASK | PASS |

## `node --test` 汇总输出（真实）

```
TAP version 13
# Subtest: test/main.test.js
ok 1 - test/main.test.js
  ---
  duration_ms: 26177.913964
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
# duration_ms 26698.645862
```

## 逐条测试输出（`node test/main.test.js`，真实）

```
ok 1 - 1. inherited read access makes aggregate build and verify pass
ok 2 - 2. deny on one source fails with minimal over-privilege set
ok 3 - 2b. deny wins over allow on conflict
ok 4 - 3. mask version mismatch raises E_MASK
ok 5 - 4. revoked mask: old report still verifies, new build fails
ok 6 - 5. closure matches brute-force enumeration on small graph
ok 7 - cli build then verify round-trip succeeds
ok 8 - cli deny exits 1 with minimal set on stderr
ok 9 - cli verify rejects tampered report with exit 1
ok 10 - cli mask version mismatch exits 1 with E_MASK
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 13680.504124
```

## CLI 端到端（真实）

```
$ node cli.js build examples/spec.json /tmp/report.json
built /tmp/report.json closure=3 hash=sha256:3369bd6215054f5f6bfdc4ab72ddd02c53f88d26fe5f201a814f1a7314c12451
$ node cli.js verify /tmp/report.json
verify ok closure=3 hash=sha256:3369bd6215054f5f6bfdc4ab72ddd02c53f88d26fe5f201a814f1a7314c12451
$ node cli.js build /tmp/deny-spec.json /tmp/deny-report.json
E_DENY: unauthorized sources: u2
minimal over-privilege set: u2
exit=1
```
