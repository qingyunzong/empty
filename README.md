# 二进制行采集的字段边界

数据库接入器通过Go包解析分块二进制行。流以ASCII字节ROW1开始，每行先有两字节大端有符号字段数，-1表示终止且之后不得有字节，其他负数非法；非负字段数必须等于调用方的固定列数。每字段以四字节大端有符号长度开始，-1表示null，其他负数非法，非负长度后跟原字节。模式包含原始字节、八字节大端有符号整数、严格UTF-8文本三种，null独立于空内容。调用方给出单字段和单行正文累计字节上限，声明超限在读正文前报错。行完整且类型合法才回调；回调暂停表示该行已接收，返回本块消费位置，恢复不重发。非法字段数、长度及数值长度报其前缀起点，非法UTF-8报非法序列首字节，截断报总输入长度；其他非法字节报该字节的绝对偏移，已交付行保留。逐字节切块测试零列、null与空、整数端点、结束标记和暂停。

## 包 API

`NewParser(Config)` 创建解析器，`Config.Columns` 给出固定列类型（`Raw`、
`Integer`、`Text`），`MaxFieldBytes` 与 `MaxRowBytes` 为正整数时分别限制单字段
正文与单行非 null 正文累计字节数，`Callback` 在每行完整且类型合法后触发。

- `Feed(chunk []byte) (consumed int, err error)`：追加任意大小的分块（可逐字节），
  返回本分块已消费位置；回调返回暂停时 `err` 为 `ErrPaused`，该行已计入交付。
- `Resume() error`：清除暂停并继续解析已缓冲数据，暂停行不会重发。
- `End() error`：声明输入结束，未收到终止标记时按总输入长度报 `ErrTruncated`。
- `Rows()` / `Delivered()`：保留所有已交付行，解析报错后仍然可查；
  `Fatal()` 返回粘性 `*ParseError`（含 `Code` 与绝对 `Offset`）。

```go
p := dataeng.NewParser(dataeng.Config{
    Columns:  []dataeng.FieldType{dataeng.Raw, dataeng.Integer, dataeng.Text},
    MaxFieldBytes: 1 << 20,
    MaxRowBytes:   4 << 20,
    Callback: func(row dataeng.Row) (pause bool) {
        handle(row)
        return false
    },
})
for chunk := range chunks {
    if _, err := p.Feed(chunk); err != nil && !errors.Is(err, dataeng.ErrPaused) {
        return err
    }
}
return p.End()
```

## 测试

`go test ./...` 覆盖零列、null 与空内容区分、整数端点（含 `math.MinInt64` /
`MaxInt64` 与八字节长度校验）、终止标记与尾随字节、暂停/恢复不重发、
逐字节切块等价性、UTF-8 非法序列定位、字段/行字节上限及截断偏移。
