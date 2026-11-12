# 列数据文件尾部索引的范围验真

数据湖读取器通过Go索引包选择性读取文件，调用方提供可失败的ReadAt、文件总长及已经解析的页索引。每页有偏移、压缩长、解码长、解码后SHA256和行区间；压缩字节用注入解码器处理，页可乱序布局但物理范围不得重叠，行范围须从0连续覆盖声明总行数。仅读取与查询行区间相交页，验证解码长及摘要后返回精确行来源；每行固定W字节，W为调用方正整数参数，解码长必须等于行数乘W；索引非法时不得调用ReadAt。用计数读取夹具测试缺口、重叠、损坏页和空查询。

## 接口

```go
reader, err := dataeng.NewReader(readAt, fileSize, index, decoder, rowWidth)
rows, err := reader.ReadRows(start, end) // 行区间为 [start, end)
result, err := reader.ReadWithProvenance(start, end)
```

- `Page`：`Offset`、`CompressedLen`、`DecodedLen`、`SHA256`、`FirstRow`、`RowCount`。
- `Index`：`TotalRows` 与 `Pages`，页列表顺序任意。
- `Decoder`：可注入接口；构造器同时接受 `DecoderFunc` 与普通 `func([]byte) ([]byte, error)`。
- `ReadRows`：只读取与查询区间相交的页，返回按行顺序拼接的定长行。
- `ReadWithProvenance`：额外返回每段结果来自哪个原始页以及页内字节偏移。
- `Read` 使用 `(start, count)` 计数语义；`ReadRows`/`ReadRange` 使用半开区间语义。

## 校验顺序

构造 `Reader` 时先完成全部索引校验，任何校验失败都会返回 `ErrInvalidIndex`，且不会调用 `ReadAt`：

1. `W > 0`，文件大小非负，页字段非负。
2. 每页 `DecodedLen == RowCount * W`，且物理范围 `[Offset, Offset+CompressedLen)` 位于文件内。
3. 物理范围按偏移排序后互不重叠；行范围排序后必须从 0 开始、无缺口、无重叠，并恰好覆盖 `TotalRows`。
4. 查询区间必须位于 `[0, TotalRows)`；空区间直接返回空结果，不读取也不解码。
5. 读取每个相交页后，先校验解码长度，再校验 SHA-256，任一失败即返回对应错误。

测试使用计数 `ReadAt` 夹具覆盖行缺口、行/物理重叠、越界、损坏摘要、错误解码长度、短读、非法查询和空查询，并断言非法索引与空查询的读取次数为 0。
