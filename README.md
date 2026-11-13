# 部分失败时的死信坐标

采集流水线调用可导入的Go包隔离失败记录，不丢弃坐标。死信保留原分区、偏移、载荷和原因码，原因码必须属于调用方清单。同一偏移再次失败只保留第一次原因，后续原因附在后面。一批里成功的记录照常交付，失败的进入死信，不能因一条失败回滚整批。用批次对照核对部分失败和重复原因，期望不得由被测包生成。

## 用法

```go
delivered, deadLetters, err := dataeng.ProcessBatch(
    records,
    []string{"invalid_json", "schema_error"},
    func(record dataeng.Record) (string, error) {
        if err := validate(record); err != nil {
            return "invalid_json", err
        }
        return "", nil
    },
)
```

`Process` 是同一流程的结果结构形式，返回 `BatchResult`。`ProcessBatch`
返回 `delivered`、`deadLetters` 和错误。即使出现非法原因码，其他成功记录和
合法死信仍会返回，不会回滚整批。

死信以 `(partition, offset)` 为坐标键。第一次失败的 `Payload` 与原因码被保留；
后续同坐标失败只追加原因码，不覆盖首因和原始载荷。原因码为空或不在调用方
清单时，该记录进入 `BatchResult.Errors`，批次继续处理。
