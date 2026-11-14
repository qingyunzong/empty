# SCD Type 2 区间修订

维度装载器需要可导入的 Go SCD2 区间组件，按业务键和源有效时间插入、改值、删除。迟到变更可拆分既有区间，相邻属性相同区间自动合并；半开区间不得重叠，当前标志唯一。输出最小增删改集合并通过时间点查询核对。

## 用法

组件位于 `scd2` 包（导入路径 `example.org/dataeng/q0114/scd2`）：

```go
s := scd2.New[string]() // 属性类型可比较时用 New，否则用 NewFunc 提供相等函数

s.UpsertAt("cust-1", t1, "gold")      // 插入
s.UpsertAt("cust-1", t2, "platinum")  // 改值：关闭旧区间并开启新区间
s.UpsertAt("cust-1", tLate, "silver") // 迟到变更：拆分既有区间
s.DeleteAt("cust-1", t3)              // 删除：关闭覆盖 t3 的区间
```

- 每次变更返回最小 `Changeset`（增 / 改 / 删），删除与更新排在新增之前，可直接用于持久化。
- `AsOf(key, t)` 提供时间点查询，`Current(key)` 返回唯一当前区间，`Intervals(key)` 返回完整区间链。
- `Validate()` 校验半开、不重叠、无零长、当前标志唯一等不变量。
- 区间语义：半开 `[From, To)`，`To` 为零值表示开放（当前）区间；最终状态与事件到达顺序无关。

运行测试：

```sh
go test ./...
```
