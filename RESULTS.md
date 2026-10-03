# RESULTS

## 测试运行（真实输出摘要）

命令：`node --test`（Node.js v22.22.1，仅标准库，node:test）

```
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
# Subtest: test/convergence.test.js
ok 3 - test/convergence.test.js
# tests 3
# pass 3
# fail 0
# duration_ms 3938.544551
```

3 个测试文件、12 个用例全部通过，0 失败。

## 验收对照

- **A 回填过去更正改变历史报表**（`test/acceptance.test.js`）
  `e1` validFrom=2024-03-01 amount=100 (tx 1)；更正 `e2` 把 validFrom 回填到
  2024-01-01、amount=150 (tx 2)。asOf(2024-02-15, tx 2) 余额变为 150（历史报表被改写），
  而 asOf(2024-02-15, tx 1) 仍为 0（旧事务时间视图保留，更正只追加）。
- **B tombstone 后旧 asOf 仍可见**（`test/acceptance.test.js`）
  tx 2 追加 tombstone 后，asOf(tx 2) 余额 0/count 0；asOf(tx 1) 仍见 amount=50。
  tombstone 本身作为追加记录留在日志中，可审计；删除只能生成 tombstone。
- **C 索引与暴力 2000 版本对照**（`test/convergence.test.js`）
  确定性 LCG 生成 2000 个版本（25 账户，含更正/tombstone/NULL amount），
  675 组 (account, validTime, txSeq) 上 `asOf`（增量索引 + 二分）与
  `asOfBruteForce`（关系代数全表扫）逐一 deepEqual，全部一致。
- **D NULL validTo 边界**（`test/acceptance.test.js`）
  NULL validTo 表示当前有效：validFrom 处可见、2099 年仍可见；可被后续更正关闭
  （旧 tx 视图仍见开区间）。闭区间 validFrom 含、validTo 不含；
  validTo <= validFrom 抛 E_TIME_ORDER。

## CLI 端到端（真实输出）

```
$ auditdb load f.jsonl --db store.jsonl
{"loaded":3,"total":3,"db":"store.jsonl"}
$ auditdb query acc --valid 2024-02-15T00:00:00Z --tx 1 --db store.jsonl
{"account":"acc","valid":"2024-02-15T00:00:00Z","tx":1,"balance":0,"limit":0,"count":0,"versions":[]}
$ auditdb query acc --valid 2024-02-15T00:00:00Z --tx 2 --db store.jsonl
{"account":"acc","valid":"2024-02-15T00:00:00Z","tx":2,"balance":150,"limit":55,"count":1,"versions":["e2"]}
$ auditdb query acc --valid 2024-02-15T00:00:00Z --tx 3 --db store.jsonl   # tx 3 为 tombstone
{"account":"acc","valid":"2024-02-15T00:00:00Z","tx":3,"balance":0,"limit":0,"count":0,"versions":[]}
$ auditdb load bad.jsonl --db store.jsonl   # validTo < validFrom
{"error":"E_TIME_ORDER","message":"event x: validTo (...) must be strictly after validFrom (...)"}
exit=1
```

注：沙箱禁止 spawn 子进程，CLI 测试通过注入 io 的 `runCli()` 在进程内驱动，
`cli.js` 薄包装设置 `process.exitCode`，错误路径 exit code = 1。
