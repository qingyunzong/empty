# pagedb — 可恢复账页库（steal / no-force + ARIES 式恢复）

仅使用 Go 标准库。实现一个允许未提交页落盘的账页库、带前后像与事务
前驱的预写日志，以及崩溃恢复：重做已提交、撤销未提交；撤销本身被再次
中断后仍然幂等。

## 模块结构

```
wal/         预写日志：记录编码（前后像 + PrevLSN 前驱 + CLR）、追加/落盘、扫描
pagestore/   文件适配器（页文件读写、页 LSN）+ 缓冲池（steal/no-force）
db/          事务管理器（提交/中止）+ ARIES 式恢复（分析/重做/撤销）
cmd/recover/ 恢复 CLI
```

## 持久化语义

- **steal**：`Store.Flush` 不检查事务提交状态，未提交事务改脏的页随时可能
  被偷写到磁盘；
- **no-force**：`Tx.Commit` 只强制日志（`Log.Sync`），不强制刷页；
- **WAL 规则**：刷页之前必须先同步日志（`Store.Flush` 内保证），因此页
  LSN 之前的日志记录一定已持久化；
- **崩溃模型**：`Log.Close`（未 `Sync`）丢弃未落盘日志尾部，未刷的脏页随
  内存丢失——测试以此精确枚举持久化边界。

## 日志记录

每条记录：`Type | LSN | PrevLSN | TxID | PageID | UndoNext | Before | After`，
带长度前缀与 CRC32，尾部撕裂/损坏时扫描安全截断。

- `UPDATE`：前像 + 后像；
- `COMMIT` / `ABORT` / `END`：事务状态；
- `CLR`（补偿记录）：撤销本身也记日志，`After` 为恢复的前像，
  `UndoNext` 指向下一条待撤销记录——这是撤销幂等的关键；
- `PrevLSN`：同事务的前驱记录，撤销沿此链回溯。

## 恢复算法（ARIES 式）

1. **分析**：扫描持久日志，重建事务表（running / committed / aborted /
   ended）；
2. **重做**：重复历史——按 LSN 顺序重放所有 `UPDATE`/`CLR`，仅当记录
   LSN 大于页 LSN 时才应用（页 LSN 守卫 ⇒ 重做幂等）；
3. **撤销**：对所有败者（未提交）事务，按最大 LSN 优先沿前驱链回溯，
   每条 `UPDATE` 写一条 CLR 并立即落盘；遇到 `CLR` 沿 `UndoNext` 跳过
   已补偿部分。撤销中途再次崩溃后，重做会按页 LSN 重放/跳过 CLR，
   撤销从 `UndoNext` 继续——任意多次中断都收敛到同一结果。

最终效果等价于"重做已提交、撤销未提交"；重复历史是 steal/no-force
下保证正确性的标准做法。

## 恢复 CLI

```sh
go run ./cmd/recover -dir <dbdir>          # 对数据目录执行恢复
go run ./cmd/recover -dir <dbdir> -demo    # 先构造一个崩溃现场再恢复
```

输出分析出的赢家/败者事务、重放记录数与写出的 CLR 数。

## 测试

```sh
go test ./...
```

- `wal`：编码往返、未同步记录丢失、撕裂尾部截断、重开后续 LSN；
- `pagestore`：页读写往返、缺页为零页、未提交页偷写落盘 + WAL 规则；
- `db`：提交可读回、中止恢复前像且写 CLR；
- `db.TestThreeTxSamePageExhaustive`：**穷举三事务写同页的持久化边界**——
  22 种事务命运组合（提交/中止/崩溃时活跃/未开始，受页锁串行化约束）
  × 刷盘边界（从不刷 / 每次操作后偷写 / 在每条日志边界处恰好偷写一次），
  崩溃后恢复，断言页面恰好等于已提交前缀，且二次恢复完全无操作；
- `db.TestCrashDuringUndoIdempotent`：撤销过程中每写一条 CLR 就崩溃一次，
  反复直到收敛（交叉"崩溃前是否偷写未提交页" × "撤销中是否偷写补偿页"
  四种组合），断言最终结果正确且后续恢复为零操作。

## 实际测试记录

在 linux/amd64、Go 1.27.1 环境下实际执行（默认构建缓存目录只读，
故将 `GOCACHE`/`GOPATH` 指到可写目录）：

```
$ export GOCACHE=/tmp/gocache GOPATH=/tmp/gopath
$ go vet ./... && go test -count=1 ./...
?   	pagedb/cmd/recover	[no test files]
ok  	pagedb/db	0.298s
ok  	pagedb/pagestore	0.010s
ok  	pagedb/wal	0.006s

$ go test -race -count=1 ./...
?   	pagedb/cmd/recover	[no test files]
ok  	pagedb/db	2.005s
ok  	pagedb/pagestore	1.049s
ok  	pagedb/wal	1.072s
```

其中 `TestThreeTxSamePageExhaustive` 展开 205 个持久化边界子用例全部
通过，`TestCrashDuringUndoIdempotent` 的 4 组撤销中断风暴全部收敛。

CLI 实测（构造崩溃现场 → 恢复 → 再恢复验证幂等）：

```
$ go run ./cmd/recover -dir /tmp/demo-db -demo
seeded crashed state: t1 committed, t2 uncommitted, uncommitted page stolen to disk
winners (committed, kept): []
losers  (uncommitted, undone): [2]
redo: 0 record(s) replayed
undo: 1 compensation record(s) written

$ go run ./cmd/recover -dir /tmp/demo-db
winners (committed, kept): []
losers  (uncommitted, undone): []
redo: 0 record(s) replayed
undo: 0 compensation record(s) written
```
