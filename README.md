# risk-index-db

离线结算账户库 + 在线风险索引。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 原表：账户（余额、`riskFlag`）、支付、撤销，全部按 WAL 追加（`wal.log` 为唯一持久化事实源），账户以 MVCC 版本链存储。
- 二级索引：`(riskFlag, account)` 唯一索引（每个 riskFlag 全局唯一，冲突报 `E_DUP_RISK`），索引条目同样带版本 `[begin, end)`。
- 回填：`backfill-begin` 记录起始版本与账户扫描顺序；扫描分批写 `backfill-scan` 进度；最后一批条目与索引水位在同一 WAL 记录（`backfill-final`）中原子提交。
- 回填期间新事务在同一 commit 记录里双写原表与待生效索引（`indexOps`）。重启续扫时，凡起始版本之后被双写接管或已登记的账户一律跳过，绝不重复登记。
- 快照隔离：`--at V` 小于水位走按版本全表扫描；`V >= 水位` 走版本化索引。旧快照不受回填后变更影响。

## CLI

```
node src/cli.js [--data DIR] build-index          # 开始/续跑回填，完成写水位
node src/cli.js [--data DIR] tx '{"ops":[...]}'   # insert/setRisk/pay/reverse
node src/cli.js [--data DIR] query --risk R [--at V]
node src/cli.js [--data DIR] status
node src/cli.js [--data DIR] crash --backfill     # 扫描一半后、写水位前模拟崩溃(退出码 2)
```

错误输出为 JSON（`{"error":{"code","message"}}`，stderr），退出码非 0。

## 测试

```
node --test
```
