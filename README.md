# 采集批次的可撤销排行

流式分析宿主调用Go排名组件维护分组中的当前记录，记录含唯一ID、组名及int64分值。一个批次按顺序执行upsert或delete：upsert替换同ID并可迁组，delete不存在ID报错，任意错误撤销整批。提交时对所有发生变化的组计算按分值降序、同分ID按UTF-8字节升序排列的前K名，K为正整数；输出旧榜到新榜的差异，删除先按旧名次升序，再新增或名次/分值改变者按新名次升序，同ID迁组按两组分别处理，组顺序按UTF-8字节。查询可持有旧版本，后续批次不得改变旧榜；输出回调失败时不提交状态，下次同批可重试。实现可导入包、并发只读查询和测试；用每批完整排序的参考实现核对同分挤出、迁组、批内删除重插和失败回滚。

## 用法

```go
r := dataeng.New(10) // 每组保留前 10 名，K 必须为正整数

err := r.Apply([]dataeng.Op{
    dataeng.Upsert("user-1", "group-a", 42),
    dataeng.Delete("user-2"),
}, func(changes []dataeng.Change) error {
    // 差异有序：组按 UTF-8 字节序；组内先删除（旧名次升序），
    // 再新增/名次分值变化（新名次升序）。返回 error 则整批不提交。
    return publish(changes)
})

board := r.Top("group-a")        // 快照副本，后续批次不影响
group, score, ok := r.Get("user-1")
```

- 批次内任意操作失败（删除不存在的 ID、空 ID/组名、未知操作类型）或输出回调失败时，状态完全不提交，同一批次可原样重试。
- `Top`/`Get`/`Len` 为并发安全的只读查询；已提交的榜单不可变，读者可长期持有旧版本。
- 测试见 `ranker_test.go`（单元语义）与 `reference_test.go`（每批完整排序的参考实现随机对照）。
