# 主机记录布局中的变长与覆盖字段

`example.org/dataeng/q0263` 是一个 Go 可导入的布局编译与记录解码包。宿主提供已解析的 copybook 子集 AST；本包不解析 COBOL 文本。

## 快速开始

```go
ast := &dataeng.AST{Root: &dataeng.Node{
    Path: "ORDER",
    Kind: dataeng.Group,
    Children: []*dataeng.Node{
        {Path: "COUNT", Kind: dataeng.UnsignedDisplay, Digits: 2},
        {Path: "LINES", Kind: dataeng.Group, Occurs: dataeng.UpTo(4, "COUNT"), Children: []*dataeng.Node{
            {Path: "SKU", Kind: dataeng.UnsignedDisplay, Digits: 3},
            {Path: "PRICE", Kind: dataeng.SignedPacked, Digits: 5, Scale: 2},
        }},
    },
}}

layout, err := dataeng.Compile(ast)
record, err := layout.Decode(data, dataeng.DecodeOptions{MaxLeaves: 100})
if err != nil {
    log.Fatal(err)
}
price := record.First("PRICE")
fmt.Println(price.Value.String(), price.Value.Scale) // 精确十进制，不经浮点
```

完整可运行调用例见 `examples/host/main.go`：

```sh
go run ./examples/host
go test ./...
```

## AST 约定

- `Node.Path` 全局唯一。未设置 `Occurs` 表示恰好一次。
- `Group` 按 `Children` 顺序连续排布，无隐式对齐。
- `UnsignedDisplay` 的 `Digits > 0`，每数字一字节 ASCII `'0'..'9'`。
- `SignedPacked` 的 `Digits > 0` 且 `0 <= Scale <= Digits`，字节数为 `ceil((Digits+1)/2)`；符号半字节 `C/F` 正、`D` 负，偶数位时最高填充半字节必须为 0。
- `RawBytes` 的 `Bytes >= 0`，输出原始字节副本。
- `Fixed(n)` 是固定正次数；`UpTo(max, control)` 是 0..max 次变长重复。控制字段必须是更早、根层、非重复的 `UnsignedDisplay`。
- `Node.Overlay` 标记相邻根层 REDEFINES 分支。`AST.Overlays` 给出覆盖名、控制字段和 `uint64 -> 分支路径` 表。

`Decimal.Value` 是规范化的十进制整数系数，实际值为
`Value * 10^(-Scale)`。负数零规范为 `0`；`Start/End` 是半开字节区间，
`Bytes` 是原字节副本。`Decimal.String()` 只做十进制字符串运算。

## 编译期拒绝

- 路径重复、空非根路径。
- 前向或未知的 `DEPENDING ON` 引用、重复的控制字段、非根层或非 unsigned display 的控制字段。
- 控制字段位于覆盖分支；覆盖组内出现变长 `OCCURS`。
- 非相邻覆盖分支、无效分支表路径、未知覆盖表。
- 类型属性组合无意义（如 group 带 digits、display 带 bytes、packed scale 越界、负 bytes）。
- `OCCURS` 上限乘法或布局大小 `int64` 溢出。

## 运行时约定

- `Decode` 要么返回完整 `Record`，要么返回 `*DecodeError`，不交付部分记录。
- `DecodeError` 含 `Code`、字段 `Path` 和记录内物理 `Offset`。
- 记录必须恰好消费全部输入；尾部多余字节或空间不足均报错。
- 覆盖组的最大分支空间总会保留；未选择分支不会读取或校验，即使其中字节非法。
- 零次 `OCCURS` 不读取子字段。`MaxLeaves > 0` 限制实际展开的叶节点数。
