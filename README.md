# SQLite 式只读 cell 投影

`example.org/dataeng/q0323` 从宿主已定位的单个表叶 cell 中投影指定列，只读取记录头、链链接头和实际请求的列值区间。它不解析数据库头、B 树目录、SQL 或 WAL，也不修改或发布快照文件。

## 接入方式

```go
config := dataeng.Config{
    PageSize:             512,  // S，512..65536 的 2 次幂
    ReservedBytes:        32,   // R，且 U=S-R>=480
    PageCount:            pages,
    HeaderByteBudget:     4096,
    ChainPageBudget:      1024,
    ProjectionByteBudget: 1 << 20,
}

result, err := dataeng.Project(
    immutableReaderAt,
    config,
    dataeng.CellRef{Page: cellPage, Offset: cellOffset, Length: cellLength},
    []int{3, 0, 3}, // 0 起始列号；重复项保留，返回顺序一致
)
```

需要复用页几何时可先调用 `NewProjector`，再调用 `Projector.Project` 或带取消支持的 `Projector.ProjectContext`。`bytes.Reader` 只是示例适配器，宿主也可以实现自己的不可变 `io.ReaderAt`。

完整可运行示例见 `example_test.go`；独立构造 cell、溢出页和完整载荷参考的夹具见 `fixture` 子包。

## 行为与限制

- cell 前缀严格按 1..9 字节 varint 规则解析；接受九字节以内的非最短表示。负 rowid 按同一 64 位位型的二补码 `int64` 返回。
- local 长度按题目给定的 M/K 规则计算，不用固定的 M，也不把页填满；cell 长度必须与“两个 varint + local + 可选 4 字节指针”精确一致。
- 溢出链先完整校验：必须恰好覆盖 `P-local`，末尾链接必须为 0；提前结束、额外页、越界、环和回指 cell 页都拒绝。
- 记录头 `H` 必须是 varint 且包含自身；直到偏移 `H` 的每个 serialType varint 都必须完整。仅支持 `0=null`、`6=int64`、`>=12` 的偶数 blob serial type；其他类型返回 `ErrUnsupportedSerial`。
- 全部列（包括未投影列）的长度和必须精确等于 `P-H`。所有校验完成后才读取并交付投影值。
- 预算字段是严格上限：`HeaderByteBudget` 限制 `H`，`ChainPageBudget` 限制溢出页数，`ProjectionByteBudget` 限制投影出现次数对应的值字节总数（重复投影重复计数）。超限返回错误且不返回部分结果。
- 不按 `P` 分配内存。`Result.Reads`（及失败时的 `Error.Reads`）记录每次实际 `ReaderAt` 请求的页号、页内/文件偏移、来源和逻辑区间，可用于禁止区间审计。
- `ColumnValue` 区分 `ValueNull` 与 `ValueBlob`；空 blob 的 `Blob` 是非 nil 的零长度切片。重复投影读取一次，但每个返回值都是独立副本，调用方改写不会影响其他结果或底层快照。
- `ColumnValue.Segments` 和 `Result.OverflowPages` 保存逻辑载荷区间到物理页的映射；最后溢出页只记录实际需要的字节，未用尾部不读取。

错误可用 `errors.Is` 检查稳定类别，例如 `ErrCellLengthMismatch`、`ErrBudgetExceeded`、`ErrOverflowChainEarly`、`ErrOverflowChainExtra`、`ErrOverflowChainCycle`、`ErrRecordLengthMismatch`、`ErrUnsupportedSerial` 和 `ErrShortRead`。失败不会返回部分 `Result`。

## 验证

```sh
go test ./...
go vet ./...
```

测试覆盖 `P=U-35` 及相邻值、K 阈值两侧、负 rowid 九字节编码、48 位以上 `P` 的预算先拒绝、记录头跨首个溢出页、值跨两个溢出页、未投影大 blob 禁止读取、空 blob/null、链恰好与多一页、保留区垃圾、头体长度不符和短读。
