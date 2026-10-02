# RESULTS

环境：Node.js v22.22.1，仅标准库，测试框架 `node:test`，命令 `node --test`。
日期：2026-10-02。

## `node --test` 真实输出摘要

```
ok 1 - test/auditdb.test.js
ok 2 - test/cli.test.js
ok 3 - test/index.test.js
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 897.65753
```

逐文件子测试（各文件单独运行均全绿）：

- `test/auditdb.test.js`：8/8 通过（验收 A/B/D、聚合 NULL 语义、E_TIME_ORDER/E_TOMBSTONE/E_TX_SEQ、持久化往返）
- `test/cli.test.js`：4/4 通过（load/query、错误退出码非零）
- `test/index.test.js`：2/2 通过（验收 C：2000 版本索引 vs 暴力对照 500 个随机查询点；单账户查询扫描量 == 该账户版本链长，远小于全表 2000）

## 验收标准对应

- **A 回填过去更正改变历史报表**：`A: backfilled correction rewrites history as of later txSeq` —— 同一 validTime，tx=1 报 balance 100，tx=2 报 250；旧版本保留在追加日志中。
- **B tombstone 后旧 asOf 仍可见**：`B: tombstone hides current view but old asOf remains visible` —— tx=1 仍见 balance 100，tx=2 起不可见，日志两行俱在。
- **C 索引与暴力 2000 版本对照**：`C: indexed asOf matches brute force over 2000 versions`（确定性种子，20 账户、含回填/更正链/tombstone/NULL amount/NULL validTo，500 个随机 (validTime, txSeq) 查询点逐一 deepEqual）；`C: indexed query never scans the full table` 断言扫描行数 == 单账户链长（≪ 2000）。
- **D NULL validTo 边界**：`D: NULL validTo is open-ended; validTo is exclusive` —— NULL validTo 在 2099 年仍有效；validFrom 含、validTo 不含。

## 真实 CLI 端到端验证（bin/auditdb.js，/tmp/auditdemo2）

```
$ node bin/auditdb.js load f.jsonl --db demo.db.json
{"loaded":3,"total":3,"db":"demo.db.json"}
$ node bin/auditdb.js query acc --valid 2024-06-01T00:00:00Z --tx 1 --db demo.db.json
{"account":"acc","validTime":"2024-06-01T00:00:00Z","txSeq":1,"balance":100,"limitUsed":20,"versions":1}
$ node bin/auditdb.js query acc --valid 2024-06-01T00:00:00Z --tx 2 --db demo.db.json
{"...","txSeq":2,"balance":300,"limitUsed":20,"versions":1}
$ node bin/auditdb.js query acc --valid 2024-06-01T00:00:00Z --tx 3 --db demo.db.json
{"...","txSeq":3,"balance":0,"limitUsed":0,"versions":0}
$ node bin/auditdb.js load bad.jsonl --db demo.db.json
error: E_TIME_ORDER: validTo (2024-01-01T00:00:00Z) must be after validFrom (2024-02-01T00:00:00Z) for event bad
exit=1
$ node bin/auditdb.js load badt.jsonl --db demo.db.json
error: E_TOMBSTONE: tombstone tx supersedes unknown event ghost
exit=1
```

注：沙箱禁止进程内 spawn 子进程（EPERM），故 CLI 测试通过 `src/cli.js` 导出的 `run()` 在进程内断言退出码与输出；真实二进制的端到端行为以上述 shell 直接调用验证。
