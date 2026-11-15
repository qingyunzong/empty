# ORC 行组谓词与时区统计

可导入的 Go ORC stripe/row-group 裁剪库。它直接解析 ORC 的 postscript、
footer、stripe footer、row index、bloom filter index、writer timezone 和
timestamp statistics，不依赖 Java/Hive 运行时。

```go
import "example.org/dataeng/q0206"

r, err := dataeng.Open("events.orc")
if err != nil {
	// ...
}
defer r.Close()

pred := dataeng.And(
	dataeng.Ge("created_at", dataeng.TimestampValue(from)),
	dataeng.Lt("created_at", dataeng.TimestampValue(to)),
	dataeng.In("tenant", dataeng.StringValue("a"), dataeng.StringValue("b")),
)
result, err := r.Prune(pred)
// result.Ranges is a list of half-open [start,end) absolute row intervals.
```

## 语义

- 支持 `Eq`、`Range`、`In`、`IsNull`、`IsNotNull` 以及 `And`/`Or`/`Not`。
- 每个候选区间覆盖完整的 row group；调用方仍应对候选区间逐行求值。
- 统计缺失、字段缺失、writer version 与 timestamp 统计形式不一致、writer
  timezone 无法解析时，相关 row group 一律 may-match。
- 旧 writer（ORC-135 之前）的 timestamp 统计按声明的 writer version 解释为
  本地墙上时间，并使用 stripe footer 中的 writer timezone 转成 UTC 候选范围。
- 夏令时回拨造成同一墙上时间对应两个瞬间、或春季跳过造成不存在墙上时间时，
  候选范围取所有可能瞬间的并集，避免假阴性。
- 2015/Unix 纪元歧义、秒/毫秒误写和旧 bloom filter 的本地时间表示也按“宁多勿漏”
  处理；无法确认时返回 may-match。
- 支持 `NONE`、`ZLIB`、`SNAPPY` 和 `LZ4` ORC 压缩块。`ZSTD`/`LZO` 会返回
  `ErrUnsupportedCompression`。

## 零假阴性验证

`VerifyNoFalseNegatives` 用逐行求值结果检查候选区间是否覆盖全部命中行：

```go
err := r.VerifyNoFalseNegatives(pred, func(row int64) (map[string]dataeng.Value, error) {
	// decode row and return values for the predicate columns
})
```

测试会用合成的 ORC 文件覆盖 row index、bloom filter、旧 writer 本地时间统计、
DST 歧义、缺失统计和多 stripe 场景。
