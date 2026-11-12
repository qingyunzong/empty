# 撤销流上的分组精确聚合

数据处理宿主需要可导入的Go聚合包，按字符串组键维护带唯一ID的可空整数记录，批次可插入、替换或删除；非法删除整批回滚。输出改变组的count、非null数、sum、min、max及最简分数avg，sum与分数使用任意精度整数，全null时除计数外均为null。空组从结果移除，值相同但ID不同分别计数；读者可保留旧版本。用每批重算参考核对极值删除、空值替换及int64端点。

## 包结构

导入路径为 `example.org/dataeng/q0073`，包名 `dataeng`：

- `db.go`：版本化入口 `DB`，并发安全，维护最新 `Snapshot`。
- `snapshot.go`：不可变快照、批次操作、`Stats`/`Fraction` 聚合类型与错误哨兵。
- `doc.go`：包级文档。

## 数据模型与语义

- 记录为 `Record{ID string, Value *int64}`，`Value == nil` 表示空值；ID 在同一字符串组内唯一。
- 批次操作 `Op` 支持 `OpInsert`、`OpReplace`、`OpDelete`。
  - Insert 要求组内 ID 不存在；Replace/Delete 要求 ID 已存在；空 ID 与未知操作类型同样非法。
  - 批次中任一条操作非法即整批回滚，返回包装了哨兵错误的 `*BatchError`（支持 `errors.Is`/`errors.As`），DB 与接收快照均保持不变。
- 每次成功提交基于旧快照做写时复制，返回新版本 `Snapshot`；旧快照永不修改，读者可长期保留。
- 组输出 `Stats`：
  - `Count` 含空值记录，`NonNull` 仅统计非空记录；同值不同 ID 分别计数。
  - `Sum` 为 `*big.Int` 任意精度；`Min`/`Max` 仅基于非空值。
  - `Avg` 为约分后的 `Fraction`（分母恒正），分子分母均为任意精度整数。
  - 组内全部为空值时，除 `Count` 外 `NonNull` 之外的 `Sum`/`Min`/`Max`/`Avg` 均为 `nil`。
  - 记录删空的组从结果移除，`Stats` 返回 `ok == false`。

## 用法

```go
db := dataeng.New()
snap, err := db.Apply([]dataeng.Op{
    {Kind: dataeng.OpInsert, Group: "g", Record: dataeng.Record{ID: "a", Value: ptr(10)}},
    {Kind: dataeng.OpInsert, Group: "g", Record: dataeng.Record{ID: "b", Value: ptr(20)}},
})
stats, ok := snap.Stats("g") // Count=2, Sum=30, Avg=15/1
old := db.Latest()           // 读者保留旧版本，后续 Apply 不影响 old
```

完整可运行示例见 `example_test.go`。

## 测试与参考核对

- `snapshot_test.go`：固定场景，覆盖极值删除、空值替换、int64 端点求和溢出、负数约分、整批回滚与访问器隔离。
- `reference_test.go`：独立参考模型对每个批次从零全量重算，与增量快照做随机差分（含 `math.MaxInt64`/`math.MinInt64` 边界值、空值、重复极值、非法批次与历史版本）。
- `db_test.go`：版本不可变、旧版本保留、空批次与并发读写（`-race` 下验证）。
