# 序列化行中的空值位图与对齐

行式数据接入宿主调用可导入的Go布局包，解码接口给单行完整字节和最大行长，编码输入必须具备全部模式字段；模式固定有序字段，类型为int64、bool或变长字节串，各自可空。行头按字段顺序低位优先有效位图，随后逐个仅编码非null字段：int64小端二补码，前填零对齐至8字节、bool为0/1、字节串为四字节小端长度及正文；末尾填零至8字节。解码须拒绝非零填充、位图未用高位、越界长度及尾随字节，返回每字段原始范围。附逆编码，按所有短模式和空值组合往返验证对齐不能按字段号预先固定。

## rowlayout 包

导入路径：`example.org/dataeng/q0197/rowlayout`

### 线路布局

单行整体按 8 字节对齐，结构为：

1. 有效位图：`ceil(字段数/8)` 字节，字段 `i` 对应第 `i/8` 字节的第 `i%8` 低位，置 1 表示非 null；最后一个位图字节的未用高位必须为 0。
2. 载荷：仅按字段顺序编码非 null 字段，因此字段偏移由位图内容决定，不能按字段号预先固定。
   - `int64`：8 字节小端二补码（含 `math.MinInt64`）。
   - `bool`：1 字节，只能是 0 或 1。
   - 变长字节串：4 字节小端 uint32 长度，后接正文；空字节串与 null 通过位图显式区分。
3. 末尾零填充，使整行长度为 8 的倍数；任何非零填充、额外尾随字节均被拒绝。

### API

- `NewSchema(fields []Field) (*Schema, error)`：构造固定有序模式，校验字段类型。
- `Encode(schema *Schema, values []Value) ([]byte, error)`：输入值数量必须与模式字段数一致，`Value{Null: true}` 才表示 null。
- `Decode(schema *Schema, line []byte, maxLineLen int) (*Row, error)`：校验最大行长与全部线路约束；`Row.Values` 为解码值（字节串内容已复制，不与输入行共享底层数组），`Row.Ranges` 返回每个字段在原行中的半开区间 `[Start, End)`，字节串范围包含 4 字节长度前缀；null 字段的 `Range.Null` 为 true。

拒绝条件分别返回可通过 `errors.Is` 匹配的哨兵错误：`ErrEmptyLine`、`ErrLineTooLong`、`ErrTruncated`、`ErrInvalidBitmap`、`ErrInvalidBool`、`ErrLengthOutOfRange`、`ErrNonZeroPadding`、`ErrTrailingBytes`、`ErrInvalidSchema`、`ErrInvalidValue`。

### 测试

`rowlayout/rowlayout_test.go` 对 0–4 个字段的全部短模式（三种类型的所有组合）和全部 null 位图组合做穷举往返，逐字段核对原始范围、位图、零填充及逆编码字节级一致；另含偏移随 null 组合变化、固定线路字节、全部拒绝路径与解码复制语义测试。
