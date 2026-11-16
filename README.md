# AMQP unsettled delivery 恢复

`delivery` 子包是可导入的 Go 库（仅依赖标准库），为 AMQP 1.0 接入器管理
入站 delivery 的持久化状态。

## 数据模型

`delivery.Record` 以 delivery-tag 为主键，关联：

- `LinkEpoch`：link 世代，每次 attach 由 `BeginGeneration` 递增；
- `DeliveryID` / `Tag`：AMQP delivery-id 与 delivery-tag；
- `Settled` / `Outcome`：settled 标志与 AMQP outcome；
- `TxnID` / `Committed`：事务归属与业务数据是否已落库提交。

`delivery.Store` 是持久化接口（`Put`/`Get`/`Update`/`Delete`/`ListUnsettled`），
`MemoryStore` 提供并发安全的内存实现；实现 `EpochStore` 可让世代计数跨进程
重启持久化，继续栅栏旧 disposition。

## 安全规则

- **世代栅栏**：`Disposition` 携带的 epoch 不等于当前世代时返回
  `ErrStaleGeneration` 且不改状态，旧 link 的迟到 disposition 无法作用于新世代。
- **断链重连对账**：`Reconcile` 返回全部未 settled 记录用于重建 unsettled
  map；`Resume` 在 link resume 握手时把旧记录登记到新 epoch 和新 delivery-id。
- **accepted 后置**：`Commit` 先调用落库回调，成功后才产生
  `OutcomeAccepted`；回调失败不产生任何 outcome，记录仍留在 unsettled map。
- **重复转移幂等**：同一 tag 的重复/重连转移不会再次执行业务写入；
  `Commit` 对已提交记录跳过回调，保证每个 tag 至多写入一次。
- **事务 outcome**：`Enlist` 登记的事务 delivery 在 `DischargeTxn` 前无
  outcome；提交后批量产生 accepted（仍待对端 settle），回滚则清除事务
  归属并回到普通 unsettled map 等待重投。

## 典型流程

```go
tracker, _ := delivery.NewTracker(ctx, store)
epoch, _ := tracker.BeginGeneration(ctx)          // link attach

in, _ := tracker.Incoming(ctx, tag, deliveryID)    // 到达的 transfer
rec, err := tracker.Commit(ctx, tag, writeToDB)    // 落库后才 accepted
_, err = tracker.Disposition(ctx, epoch, tag,
    delivery.OutcomeAccepted, true)                // 对端 settle

unsettled, _ := tracker.Reconcile(ctx)             // 重连后对账
```
