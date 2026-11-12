# 嵌套数据的路径冲突归一化

记录接入服务通过可导入的Go包把扁平字段路径还原为嵌套对象与数组。路径段有字段名或非负整数两种显式类型；同一路径可重复且值结构相等时合并，值不同或某位置既作容器又作值则拒绝整条记录。数组允许稀疏索引，空洞返回missing标记而非null，限制最大索引和总展开格数，超限不得分配巨量切片。空路径可表示整根值，数组和对象不得混用。对象字段按UTF-8字节序返回，输出每叶值的所有原字段序号。测试容器类型冲突、同值重投及稀疏预算，以逐路径树模型核验。

## 包结构

导入路径为 `example.org/dataeng/q0094`，包名 `dataeng`：

- `nest.go`：路径段 `Segment`、输出 `Node`、`Limits` 等公共类型
- `build.go`：`Build` 构建器，数组以稀疏 `map` 存储，物化时才生成切片
- `errors.go`：`ConflictError` 与五类拒绝原因
- `value.go`：叶子标量类型校验
- `*_test.go`：表驱动测试、可执行示例，以及独立的逐路径参考树模型交叉核验

## 核心语义

- 路径段由 `NameSegment`（对象字段）或 `IndexSegment`（非负数组索引）显式构造。
- 同一叶子路径重复提交时，值经 `reflect.DeepEqual` 判定结构相等则合并，并在 `Node.Origins`
  中按序保留全部原字段序号；值不同返回 `ReasonValueMismatch`，整条记录拒绝且树为 `nil`。
- 同一位置被同时当作容器与值、或数组与对象混用时返回 `ReasonTypeConflict`。
- 稀疏数组空洞用共享标记 `MissingNode`（`Kind == Missing`，非 `null` 叶子）表示；
  显式 `nil` 仍是带 `Origins` 的叶子。
- `Limits.MaxArrayIndex` 限制最大索引（含边界，`-1` 表示不限制）；`Limits.MaxCells`
  限制所有数组的展开格数总和，每个数组按 `最大索引+1` 计，空洞同样占格（`<=0` 表示不限制）。
- 构建期数组仅用 `map[int]*bnode` 保存已提交索引，预算在写入前增量校验，
  超预算或越界不会按索引预分配切片；只有全部校验通过后才在物化阶段分配最终切片。
- 空 `Path` 表示整根值；根级值与根级容器互斥，根级数组与对象互斥。
- 对象字段按 Go 字符串序（即 UTF-8 原始字节序）输出。

## 快速使用

```go
root, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: 1024, MaxCells: 4096})
if err != nil {
    var conflict *dataeng.ConflictError
    if errors.As(err, &conflict) {
        log.Fatalf("record rejected: reason=%s path=%v", conflict.Reason, conflict.Path)
    }
}
// root.Kind 为 Object/Array/Leaf；数组空洞处的元素等于 dataeng.MissingNode。
```
