# CSV 流式错误隔离

面向导入管线的分块安全分隔文本解析器。输入可以从任意字节位置切开，
包括切在引号内换行、双引号转义、UTF-8 字符或多字节分隔符中间。同一个
输入无论一次读入还是按任意方式分块，得到的记录、错误和字节区间完全一致。

## 快速使用

```go
rd := dataeng.NewReader(src, dataeng.WithDelimiter("||"))
defer rd.Close()

for rd.Next() {
    rec := rd.Record()
    if rec.Err != nil {
        // 只影响这条记录；继续 Next 即可读取下一条。
        continue
    }
    for _, f := range rec.Fields {
        raw := f.Raw              // 原始字段字节，包含外层引号
        value := f.Value          // 解码后的值
        start, end := f.Start, f.End
        // raw == input[start:end]
        _, _ = value, start
        _ = end
    }
}
```

分块推送接口：

```go
p := dataeng.NewParser(dataeng.WithDelimiter("||"))
recs, _ := p.Feed(chunk1)
recs2, _ := p.Feed(chunk2)
tail, _ := p.Flush() // EOF 时的最后一条记录
```

一次性接口 `Parse`、`ParseChunks` 与分块接口共享同一状态机：

```go
records, err := dataeng.ParseChunks(chunks, dataeng.WithDelimiter("||"))
```

## 数据模型

- `Record.Start`/`Record.End`：逻辑记录在原始输入中的半开字节区间，不含行尾。
- `Record.Raw`：记录原始字节副本。
- `Field.Start`/`Field.End`：字段原始字节区间，含外层引号。
- `Field.ContentStart`/`Field.ContentEnd`：引号之间的原始字节区间。
- `Field.Raw`：原始字段字节副本；`Field.Value`：解码值。
- `Field.Quoted`：字段是否由引号包围。

偏移量是相对于整个输入流的绝对偏移，而不是相对于当前块或当前记录。
`Record.Err`、`Field` 和 `Record.Raw` 在后续读取后仍然有效。

## 错误与恢复

- 非法引号（未加引号字段中的裸引号、结束引号后出现非法字符）会记录到
  `Record.Err`，扫描器随后跳到下一条物理行，后续记录继续解析。
- `MaxFieldSize` 超限时当前记录带 `ErrFieldTooLarge`，但记录边界仍会被
  正常定位。
- `MaxRecordSize` 超限时停止保留当前记录字节，但状态机继续寻找可靠边界；
  后续记录不受影响。
- `LazyQuotes` 可关闭严格引号检查；`TrimLeadingSpace`、`Comment`、
  `FieldsPerRecord`、`KeepEmptyLines` 等选项与常见 CSV 行为兼容。

## 配置

`Config` 或选项均可使用：

```go
cfg := dataeng.Config{
    Delimiter:        []byte("||"),
    LazyQuotes:       false,
    MaxFieldSize:     1 << 20,
    MaxRecordSize:    8 << 20,
    KeepEmptyLines:   false,
}
rd := dataeng.NewReader(src, cfg)
```

`Delimiter` 支持任意非空字节序列（不能包含 CR/LF）；`Comma` 是单 rune
别名，兼容 `encoding/csv` 的配置习惯。
