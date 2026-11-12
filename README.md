# S8 码组增量行解码包

本包只处理封闭的 S8 数据区：8 字节操作码组头、组头之后的 253 字面槽、行/字段
槽消费、投影和物理来源。它不解析 SPSS/SAV 文件字典，不运行统计，也不声明完整
SAV 兼容性。

## 接入

```go
cfg := dataeng.Config{
    Fields: []dataeng.Field{
        dataeng.NumericField("id"),
        dataeng.BytesField("name", 12),
        dataeng.NumericField("score"),
    },
    NumericEndian: dataeng.LittleEndian,
    Bias:          100,
    MaxRows:       200,
    RowByteBudget: 4096,
    Projection:    []string{"score", "name"}, // 可选，保留请求顺序
}

d, err := dataeng.NewDecoder(cfg) // 声明错误在读数据前返回
if err != nil { ... }

for _, chunk := range chunks {
    rows, err := d.Push(chunk) // Push 可接受任意切分
    ...
}
if err := d.Finish(); err != nil { ... } // 成功才代表流完整
```

若宿主已经一次持有完整数据区，也可用 `dataeng.DecodeAll(data, cfg)` 的便捷封装；
它仍然要求显式 252 和成功 `Finish`。

完整宿主示例见 `examples/host/main.go`，可运行：

```sh
go run ./examples/host
```

## 契约

- 每个码组先写 8 个 `u8` 操作码，再按组内码序写所有 253 需要的 8 字节字面槽。
  不能按“一个码后立刻一个值”解析。
- `numeric` 占 1 槽；`bytes(width)` 占 `ceil(width/8)` 槽，`width` 为
  `1..1048576`。字段名必须唯一。
- `0`：padding，不生成槽、不前进字段。
- `1..251`：仅 numeric；生成精确整数 `code-bias` 的 canonical binary64 位型。
- `253`：消费一个字面槽。numeric 按给定端序解码位型，固定
  `0xffefffffffffffff` 转为 missing；bytes 保留原字节。
- `254`：仅 bytes；生成 8 个 ASCII 空格。
- `255`：仅 numeric；生成 missing。
- `252`：终止码，不生成槽；必须位于完整行边界，组内其后操作码必须全为 0。
  终止组之前 253 的字面槽仍在整个 8 字节组头之后，必须先消费并验证；252 之后
  不允许再藏 253 或字面槽。终止组之后不允许任何物理字节。
- bytes 字段由连续逻辑槽拼接；最后一个槽中超出声明宽度的字节必须全为 ASCII
  空格，然后裁掉。`0` 码不会消耗字段位置，长字符串的后续槽也不会变成下一个
  字段。
- 只有显式 252 且 `Finish` 成功时才报告完整。物理 EOF 没有 252、组头不足 8
  字节、字面槽不足 8 字节都返回 `ErrTruncated`，即使已经落在行边界。
- `Push` 返回本次调用中完成且校验通过的行；未完成行不交付。错误是永久失败
  态，之前交付的行保持有效；失败后的 `Push`/`Finish` 和重复 `Finish` 返回
  `ErrState`。
- 投影只影响输出字段和输出顺序，所有未投影字段仍做码类型、padding 和行完整性
  校验。未投影 bytes 不拼接完整字符串，只保留当前槽和槽计数。
- `Value.Source` 或 `Value.Fragments[].Source` 给出码组物理偏移、码下标和
  253 字面槽的物理区间。未消费字面槽的 `LiteralOffset` 为
  `dataeng.NoLiteralOffset`；重复的 `0` 码不会伪造行来源。
- 内存只保留 8 字节组头、一个待处理字面槽、当前未交付行的投影值，不保留整个
  输入流。声明字段宽度超过 `RowByteBudget` 时在 `NewDecoder` 中拒绝；超过
  `MaxRows` 时在产生该行前返回 `ErrRowLimit`。

## 实现与验证

- `internal/s8fixture`：独立的码组编码夹具，负责把逻辑槽排成
  “8 字节组头 + 组内 253 字面槽”，并给出每个槽的物理位置。
- `internal/s8ref`：一次性、非增量的参考解释器，用于独立对照。
- 测试对同一流的所有二切点、所有固定块长、200 组随机切分比较完整 `Row`
  值、字节片段、缺失标志、位型和全部 `Source`；并对每个字节前缀验证截断。

覆盖场景包括：码组跨两行、长 bytes 跨三个组、最后一行 253 字面槽物理上位于
252 之后、同组多个 253、NaN 与负零位型、255/固定位型系统 missing、字符串含
`0x00`/`0xff`、未投影列坏 padding、非法码类型、终止后额外字节、逐字节截断、
投影顺序、行数上限和预算拒绝。

运行：

```sh
go test ./...
```
