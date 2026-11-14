# 固定宽度记录版本识别

主机数据接入层需要可直接接入 Go 固定宽度记录解码库，根据记录长度、版本判别字段和 EBCDIC code page 选择 schema。packed decimal、overpunch 与空白填充值分别验证；坏记录保留原偏移并隔离，跨块时不得按 UTF-8 字符数切字节。

## 用法

```go
reg := dataeng.NewRegistry()
err := reg.Register(&dataeng.Schema{
    Name:         "acct",
    Version:      "01",
    RecordLength: 18,
    CodePage:     dataeng.CP037, // 或 CP1047
    Discriminator: &dataeng.Discriminator{Offset: 0, Length: 2, Values: []string{"01"}},
    Fields: []dataeng.Field{
        {Name: "VER",  Offset: 0,  Length: 2, Type: dataeng.FieldString},
        {Name: "NAME", Offset: 2,  Length: 8, Type: dataeng.FieldString, Nullable: true},
        {Name: "AMT",  Offset: 10, Length: 4, Type: dataeng.FieldPackedDecimal, Scale: 2},
        {Name: "QTY",  Offset: 14, Length: 4, Type: dataeng.FieldZonedDecimal},
    },
})

r, err := dataeng.NewReader(src, reg, dataeng.CP037, 18)
good, bad, err := r.ReadAll() // good 与 bad 分离；bad 保留绝对偏移与原始字节
```

## 设计要点

- **Schema 选择**：`Registry.Match` 依次按记录字节长度、EBCDIC code page、版本判别字段（解码后比对 `Values`）筛选；无判别字段的 schema 作为该 (长度, code page) 的兜底。
- **字段验证**：packed decimal 逐半字节校验数字与符号位；zoned/overpunch 校验前导字节的 zone nibble 与末字节符号（`0xC`/`0xF` 正、`0xD` 负）；全空白值按 `Nullable` 判定为 null 或错误。三类字段各自独立验证，单字段失败不影响其余字段。
- **坏记录隔离**：schema 不匹配或字段校验失败的记录进入 `BadRecord`，保留绝对字节偏移与原始字节，好记录流不中断。
- **跨块切分**：`Reader` 以固定字节数切帧，任意块大小都会先重组完整记录再解码；切分只按字节计数，与 UTF-8 字符数无关。
