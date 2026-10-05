# pagestore — ARIES 式页库与恢复

仅使用 Go 标准库实现的迷你页库：允许未提交页落盘（STEAL），提交不强制刷页
（NO-FORCE），日志记录前后像与事务前驱链，恢复时重做已提交、撤销未提交，
且撤销自身被再次中断后仍然幂等。

## 布局

- `fileadapter/` — 文件适配器：定长 4KiB 页的随机读写、`Sync` 落盘。
- `wal/` — 预写日志。每条记录含 LSN、类型、事务 ID、**前驱 LSN**（事务内
  链）、页 ID、偏移、**前像/后像**、CLR 的 undoNext 指针及 CRC32；扫描在
  撕裂/损坏尾部处停止。追加先 staged 在内存，`Flush` 才持久化，精确建模
  崩溃时的持久化边界。
- `db/` — 缓冲池 + 事务（`Begin/Write/Commit/Abort`）+ ARIES 恢复
  （`Recover`：分析 → 重做全部历史（pageLSN 校验保证幂等）→ 按最大 LSN
  优先撤销 loser，逐条写 **CLR**）。页头 8 字节存 pageLSN；`FlushPage`
  先刷日志再写页（WAL 规则）。
- `cmd/recover/` — 恢复 CLI：`go run ./cmd/recover -dir <数据目录>`，
  打印扫描记录数、winner/loser、重做与 CLR 计数；可重复运行。

## 幂等性

- 重做幂等：仅当 `pageLSN < record.LSN` 才应用后像。
- 撤销幂等：撤销写 CLR（后像=被撤销记录的前像，undoNext 指向事务前驱）。
  撤销中途崩溃后，重做先重放 CLR 映像，撤销沿 undoNext 跳过已补偿记录，
  不会重复撤销。`RecoverOptions.CrashAfterCLRs` 测试钩子模拟撤销中断。

## 穷举测试（三事务写同页）

`db/recovery_test.go`：T1/T2/T3 写同一页的三个不相交区域，穷举

- 提交掩码 8 种（其余事务中止）；
- 崩溃点 7 个（6 个操作的每个前缀之后）；
- 脏页落盘点 0..3（第几次写后被 steal 到盘，含从不）；

共 **176 个崩溃/持久化场景**，每个场景断言：提交事务的区域保留其值，
未提交/中止事务的区域恢复为前像；随后同进程与重开进程各再恢复一次，
断言为零操作。另有撤销阶段被连续两次中断后仍收敛、STEAL/NO-FORCE 端到端、
WAL 撕裂尾部/CRC 损坏/重开 LSN 延续等单测。

## 实测结果

```
$ go test ./... -count=1
?   	pagestore/cmd/recover	[no test files]
ok  	pagestore/db      	0.043s   (含 176 个穷举场景)
ok  	pagestore/fileadapter	0.004s
ok  	pagestore/wal     	0.005s
$ go test ./... -count=1 -race   # 亦全部通过
```
