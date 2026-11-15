# ORC 字符串流解码

可导入的 Go 组件，用于解码 ORC 字符串列的 stripe/row group 数据：

- `DIRECT` / `DIRECT_V2`：`DATA` 为拼接的 UTF-8 字节，`LENGTH` 为每个非 null 值的长度。
- `DICTIONARY` / `DICTIONARY_V2`：`DATA` 为字典下标，`DICTIONARY_DATA` 为字典字节，`LENGTH`（或 `DICTIONARY_LENGTH`）为字典项长度。
- `PRESENT` 采用 ORC 的 MSB-first 位图；缺省表示全部非 null。
- 整数流支持 ORC RLEv1 与 RLEv2（short repeat、direct、patched base、delta）。
- `Seek` 是确定性的：任意随机 seek 的结果与从 stripe 起点顺序解码完全一致。
- 每个 stripe/row group 独立重建字典、数据游标和整数流状态，行号连续。
- `DATA`/`LENGTH` 缺失只在全部行均为 null 时合法。

## 用法

```go
values := []dataeng.Value{
    {Text: "Nevada"},
    {Text: "California"},
    {Null: true},
    {Text: "Nevada"},
}

stripe := dataeng.EncodeDictionary(values, true) // DICTIONARY_V2
decoder, err := dataeng.NewStringDecoder(stripe)
if err != nil {
    return err
}

if err := decoder.Seek(2); err != nil {
    return err
}
_, valid, err := decoder.Next() // null row: false, nil

all, nulls, err := decoder.DecodeAllFromStart()
```

也可以直接构造流：

```go
decoder, err := dataeng.NewStringDecoder(dataeng.StringStream{
    Rows:     3,
    Encoding: dataeng.DirectV2,
    Present:  presentBits,
    Data:     concatenatedBytes,
    Length:   rleV2Lengths,
})
```

编码切换可用 `RowGroups` 表示，或调用 `SwitchEncoding` 追加一段新编码的数据。两种方式都会保留全局行号。

## 测试

```sh
go test ./...
```
