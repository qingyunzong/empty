# 删除文件与数据文件的序列门槛

数据湖扫描器调用可导入的Go行可见性包，数据行含文件ID、行号、键和数据序号；位置删除只匹配同文件行号，等值删除按指定键列匹配且仅作用于数据序号严格小于删除序号的行。键列类型由调用方固定为int64或字符串，类型不符拒绝；键允许null并按值相等，删除可来自多个文件，文件读取批次交错；返回每行首个适用删除证据，按删除序号再删除文件ID决胜。先完整校验删除索引再扫描，不修改输入。用全量逐行参考测试序号相等、null键及位置和等值删除并存。

## 使用方式

```go
deletes := []dataeng.Delete{
    dataeng.NewPositionDelete("delete-pos", 4, "data-a", 2),
    dataeng.NewEqualityDelete("delete-eq", 7, int64(42)),
}

index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, deletes)
if err != nil {
    // 删除索引中的键类型、删除类型或行号不合法；不会进入扫描。
}

rows := []dataeng.DataRow{
    {FileID: "data-a", RowNumber: 2, Key: int64(42), DataSequenceNumber: 3},
    {FileID: "data-b", RowNumber: 2, Key: int64(42), DataSequenceNumber: 3},
}

results, err := index.Scan(rows)
// results[0].Deleted == true，证据是 delete-pos（序号 4 更早）。
// results[1].Deleted == true，证据是 delete-eq（位置删除文件不同）。
```

`ScanBatch` 与 `Scan` 等价，适合多个文件读取批次交错的调用方式；`FirstDelete` 返回单行结果。返回的 `*DeleteEvidence` 是副本，修改它不会改变索引。

## 匹配语义

- 位置删除只比较 `DataFileID` 与 `RowNumber`，不使用键，也不要求数据序号门槛。
- 等值删除按键值相等匹配，且要求 `DataSequenceNumber < SequenceNumber`；序号相等时不删除。
- `nil` 键表示 NULL，NULL 与 NULL 相等；NULL 与 `0`、空字符串或其他值不相等。
- 索引键类型由调用方固定为 `KeyTypeInt64` 或 `KeyTypeString`。删除键或数据键类型不符时返回 `ErrKeyTypeMismatch`；`nil` 键在两种类型下都合法。
- 同一行有多个适用删除时，先取最小删除序号，再取字典序最小的删除文件 ID；仍相同则保留原始输入顺序。
- `BuildDeleteIndex` 在返回索引前遍历并校验全部删除。`Scan` 也会先校验全部数据行，出错时不返回部分结果。
- 构建索引用内部副本并只对副本排序；扫描只读。输入切片和行结构不会被修改，构建后的索引可并发扫描。

## 测试

`visibility_test.go` 包含逐行暴力参考实现：随机生成多文件交错删除与数据批次，对每一行独立枚举全部删除，并与索引结果逐行比对证据。定向用例覆盖序号相等、严格大于边界、NULL 与零值/空字符串区分、位置与等值删除并存及删除文件 ID 决胜。
