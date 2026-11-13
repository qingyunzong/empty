# 记录批的偏移差与事务标记

日志接入调用可导入的Go包读取记录批，不连接集群。基础偏移加上最后偏移差必须等于批内最后一条记录的偏移。时间戳差是相对批次最大时间戳的非正整数。事务标记只有提交和中止两种；出现标记时业务记录仍保留，可见性交给调用方。单条记录长度超过宿主上限时在长度可读后拒绝。用独立偏移账核对差值方向、事务标记和长度上限，期望不得由被测包生成。

## 用法

包路径为 `example.org/dataeng13/q0036`，包名为 `dataeng`。读取入口只接收调用方已经取得的字节，不会建立任何集群或网络连接。

```go
reader, err := dataeng.NewReader(64 << 10) // 单条记录长度上限
if err != nil {
    // 上限必须为正数
}

batch, err := reader.ReadBatch(data) // data 必须恰好包含一个批
if err != nil {
    // 可用 errors.Is 判断具体违反的不变量
}

for _, record := range batch.Records {
    if record.Control {
        // Commit / Abort：记录仍在 Records 中，是否可见由调用方决定
        continue
    }
    // 业务记录照常处理
}
```

便捷入口：

```go
batch, err := dataeng.ParseBatch(data)                       // 默认 1 MiB 上限
batch, err = dataeng.ParseBatchWithLimit(data, limit)        // 指定上限
batches, err := dataeng.NewDefaultReader().ReadBatches(buf)  // 读取连续多个批
```

## 校验规则

- 仅支持 magic 2 的未压缩批；其他 magic 或压缩编码返回错误。
- `BaseOffset + LastOffsetDelta` 必须等于批内最后一条记录的偏移；偏移差必须非负且严格递增。
- 每条记录的 `Timestamp` 由 `BaseTimestamp + TimestampDelta` 得到，必须不大于 `MaxTimestamp`，即相对批次最大时间戳的差为非正整数。
- 控制记录的事务标记只接受 `MarkerCommit`（1）和 `MarkerAbort`（0）；其他标记返回 `ErrUnknownTransactionMarker`。控制记录不会被过滤，`Batch.Records` 同时保留业务记录和控制记录。
- 读到单条记录的四字节长度后立即与宿主上限比较；超限返回 `ErrRecordTooLarge`，不会先读取或分配记录正文。`Record.Key`、`Record.Value` 和 header 字节引用调用方输入缓冲区。
- 批长度、记录长度、变长整数和各类字段长度都会做边界检查；`CRC` 字段会原样暴露，但本包不校验 CRC。

## 错误

所有校验错误都可用 `errors.Is` 匹配：`ErrTruncated`、`ErrInvalidBatch`、`ErrUnsupportedMagic`、`ErrUnsupportedCompression`、`ErrInvalidRecord`、`ErrInvalidVarint`、`ErrRecordTooLarge`、`ErrInvalidOffsetDelta`、`ErrRecordOrder`、`ErrLastOffsetMismatch`、`ErrTimestampAfterMax`、`ErrInvalidTimestamp`、`ErrInvalidControlRecord`、`ErrUnknownTransactionMarker`。

## 测试

```sh
go test ./...
```

测试使用测试代码内独立构造的线格式和偏移账（`wire_test.go`），期望的偏移、时间戳和标记均来自账本数据而不是被测包，覆盖差值方向、事务标记保留、长度上限及截断输入。
