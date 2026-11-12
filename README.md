# 可重叠列表视图的紧凑重建

数据接入宿主调用可导入的Go列表视图包，输入共享子值数组以及每行的起点、长度和有效位，非null行可引用重叠或逆序出现的区段。标量子值为可空int64，输出标准连续offset列表列，只按行序复制有效行子值，null行长度归零，空列表仍非null；返回每个输出子值的原始位置。检查非null区段越界及总长度溢出，null行无效偏移不读取。支持子值自身为列表视图的递归转换，限制嵌套深度。与完整递归展开模型对照重叠、空层及精确上限。

## 用法

```go
view := &dataeng.ListView{
    Starts:  []int64{1, 0, 0},
    Lengths: []int64{3, 0, 2},
    Valid:   []bool{true, false, true},
    Child:   &dataeng.Int64Array{Values: []int64{10, 11, 12}, Valid: []bool{true, true, false}},
}
col, err := dataeng.Compact(view) // col.Offsets 连续，col.Positions 记录原始位置
```

- `ListView.Child` 为 `*Int64Array`（标量层）或 `*ListView`（嵌套层，最深 `MaxDepth`）。
- `ExpandView` / `ExpandColumn` 是完整递归展开参考模型，用于对照紧凑结果。
