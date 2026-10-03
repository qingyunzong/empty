# settle-risk-index

离线结算账户库 + 在线风险索引（Node.js 22，仅标准库，测试用 `node:test`）。

## 模型

- 原表：账户（余额）、支付、撤销、riskFlag，全部经 WAL 提交，版本号单调递增。
- 新索引：`(riskFlag, account)` 唯一二级索引，索引项带版本区间 `[begin, end)`（MVCC 可见性）。
- 回填：`build-index` 从事务开始版本（快照 S）扫描全表；期间新事务对旧表和待生效索引**双写**；最后一批索引项与索引水位 `watermark = S` 在**同一个 WAL 记录**中提交。
- 崩溃恢复：WAL 追加写 + fsync，撕裂的尾部行在恢复时忽略；`crash --backfill` 在扫描一半后、写水位前模拟宕机（遗留的锁由 stale-pid 检测回收）；重启后 `build-index` 从持久化游标继续，绝不重复登记同一 `(riskFlag, account)`。
- 快照隔离：`--at V < watermark` 的查询走按版本全表扫描；`V >= watermark` 走索引（按版本区间过滤可见性）。

## CLI

```sh
node cli.js [--dir D] build-index [--batch N] [--delay-ms N]
node cli.js [--dir D] tx '{"ops":[{"op":"insert","account":"A","amount":100},
                              {"op":"pay","account":"A","id":"p1","amount":30},
                              {"op":"reverse","payment":"p1"},
                              {"op":"risk","account":"A","flag":"R1"},
                              {"op":"unrisk","account":"A"}]}'
node cli.js [--dir D] query --risk R1 [--at V] [--scan]
node cli.js [--dir D] status
node cli.js [--dir D] crash --backfill
```

成功：JSON 到 stdout，退出码 0。错误：JSON `{"error":{"code","message"}}` 到 stderr，非零退出。
唯一标志冲突返回 `E_DUP_RISK`。

## 测试

```sh
node --test
```
