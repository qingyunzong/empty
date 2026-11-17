# Go SSI Commit Oracle

供数据库事务管理器提交路径调用的 SSI（Serializable Snapshot Isolation）判定库。库本身不保存元组版本，只维护快照、读写集合、并发区间和 SSI 依赖边；调用方仍负责 MVCC 版本存储与回滚私有写入。

## 使用

```go
m := formal.NewManager()
tx, _ := m.Begin(formal.TxOptions{})

_ = tx.Read("acct:1")
_ = tx.Write("acct:2")

decision := tx.Commit()
if !decision.Committed {
    // decision.Victim 已被标记为 aborted；回滚该事务。
}
```

`Commit` 会先做 SI 写写冲突检查（first-committer-wins），再做 SSI 危险结构检查。返回的 `Decision` 包含：

- `Committed`：当前事务是否可提交。
- `Victim`：本次判定选中的牺牲者；可能不是当前事务。
- `Structures`：形如 `In --rw--> Pivot --rw--> Out` 的危险结构。
- `Reason`：稳定的判定原因。

牺牲者策略通过 `WithVictimPolicy` 选择：默认 `VictimPivot`；也可按事务 ID 选择最低或最高者。只有在某个候选事务覆盖全部危险结构时才会选择非 Pivot 事务，否则回退到当前 Pivot，保证一次判定能消除全部已识别结构。

## 快照与依赖

- 每个事务在 `Begin` 时取得可见性序列；写入者提交序列早于该序列才可见。
- `Read` 对不可见写入者建立 `reader ->rw writer` 边；`Write` 对并发旧读者建立 `reader ->rw writer` 边。
- `Commit` 既检查当前事务作为 Pivot 的结构，也检查当前事务作为 In、向已提交 Pivot 晚发布边的结构；后者用于覆盖提交后才建立依赖的跨代环。
- 只读事务若在无活动读写事务时开始，其 `Snapshot.Safe` 为真。安全只读事务不可能闭合 SSI 环，因此不会作为危险结构源触发误杀。
- `BeginContext` 配合 `TxOptions{ReadOnly: true, Deferrable: true}` 会等待安全快照；`SafeSnapshot` 与 `WaitForSafeSnapshot` 提供同样的检查/等待能力。

## 增量回收与跨代依赖

事务结束时不直接删除全部关联边。规则是：

- 任意端点仍活动时保留边。
- 两端都已结束时，如果边的源端是已提交 Pivot 且仍有活动事务与其重叠，则保留该出边。该活动事务之后可能才发布 `newIn ->rw pivot`，届时需要已有的 `pivot ->rw out` 来完成判定。
- 已结束事务的键访问也有相同保留条件；最后一个重叠事务结束后立即回收。
- 中断事务的边和键访问立即回收。

`Stats` 暴露 `LiveEdges`、`LiveKeyAccesses`、`EdgesCreated`、`EdgesReclaimed`，便于验证增量回收没有泄漏。

## 正确性验证

`serial_oracle_test.go` 实现独立的 MVCC 模拟器：

1. 按调度重放版本提交和快照读取。
2. 构造 `ww`、`wr`、`rw` 串行化图并检测环。
3. 穷举小规模事务程序的所有合法交错。
4. 对比 SSI 是否漏杀（有环但无牺牲者）或误杀（无环却牺牲事务）。

当前测试覆盖：

- 二事务写偏斜：70 个交错。
- 三事务环：34,650 个交错。
- 只读事务与写入者：20 个交错。
- 并发写写冲突：20 个交错。

三事务环的穷举结果为 `cycles=33168`、`victimized=33168`、`false-kills=0`、`missed=0`。这是所列小规模测试空间的结果；SSI 本身仍可能在更大调度空间产生保守误杀。运行：

```sh
go test ./...
go test -race ./...
```
