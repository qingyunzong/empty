# logcompact

MVCC 风格的日志压缩库：将事务日志压缩到指定提交版本（compaction
horizon），同时保留未决事务恢复依赖与活跃读者所需记录，并为每条记录
输出保留/丢弃原因。

## 保留规则（`Compact`）

一条记录被保留，当且仅当满足以下任一条件：

1. **未决事务恢复**（`ReasonPendingTxn`）：所属事务既未提交也未中止，
   恢复/回滚时必须保留。
2. **超出压缩水位**（`ReasonBeyondHorizon`）：提交版本大于 horizon，
   原样保留。
3. **读者/恢复可见**（`ReasonVisibleToSnapshot`）：该记录是其 key 在
   恢复水位或某个活跃读者快照下的可见版本。

其余记录被丢弃并注明原因：被更新版本取代（`ReasonDropSuperseded`）、
属于已中止事务（`ReasonDropAborted`）、已提交事务的过期元数据
（`ReasonDropObsoleteMeta`，写入记录已带上解析后的提交版本，压缩后的
日志自包含）。

## 代际读者注册表（`Registry`）

读者通过 `Acquire(snapshot)` 固定快照，返回带槽位代际号的 `Handle`；
`Release` 仅在代际号匹配时生效。槽位释放后被新读者复用时代际号递增，
旧句柄的过期释放（ABA）返回 `ErrStaleHandle`，不会误删新读者的固定。

## 验证

`go test ./...` 覆盖：

- 随机事务轨迹（100 个种子 × 300 条记录）：压缩日志与全日志在恢复
  水位、每个活跃读者快照及最新版本上的可见状态完全一致；未决事务
  记录零丢失；压缩幂等（二次压缩不再丢弃任何记录）。
- 注册表随机模型测试（2000 次随机 acquire/release，含过期释放）。
- 确定性轨迹：逐一断言每条记录的保留/丢弃原因，并打印完整报告。
