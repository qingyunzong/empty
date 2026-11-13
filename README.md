# 数据库 CDC 事务跨分片重组

变更采集服务要可直接接入的 Go CDC 事务重组库，输入来自多个分片的 begin/row/commit 事件及全局提交序。事务只有在所有声明分片完成后可见；同事务重复片段按位置去重，冲突即隔离。水位仅越过已知完整事务，重启重放得到相同发布批次。

## 接入方式

```go
asm := dataeng.New()

// 来自分片的事件逐条送入；Apply 返回本次水位推进越过的批次（无则 nil）。
batch, err := asm.Apply(dataeng.Event{
    Shard: "shard-a", TxnID: "txn-1", Kind: dataeng.EventBegin,
    Pos: 1, Shards: []string{"shard-a", "shard-b"}, // 声明参与分片
})

// 重启恢复：可 Snapshot/Restore，或直接从头重放事件，两者发布批次一致。
data, _ := asm.Snapshot()
restored, _ := dataeng.Restore(data)
```

## 语义约定

- **可见性**：事务只有在所有声明分片（Begin/Commit 的 `Shards`）都提交后才发布。
- **去重**：同一事务的重复片段按 `(分片, Pos)` 去重；同位置内容冲突、声明分片不一致、
  全局序不一致等情况会将整个事务隔离（`Quarantined`），其后续事件被忽略。
- **水位**：全局提交序约定为从 1 开始的稠密整数；水位从当前值起逐个越过已知完整事务，
  遇到未知序号或未完整事务即停止。被隔离事务会挡住水位，运维确认后用 `Skip` 放行。
- **确定性**：发布批次的切分只取决于输入事件序列，重放同一序列得到相同批次；
  批内事务按全局序升序，事务内行按 `(分片, Pos)` 排序。

## 测试

```sh
go test ./... -race
```
