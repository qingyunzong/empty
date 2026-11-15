# CSV 多文件方言证据合并

可导入的 Go CSV 方言判定库。它把多个样本当作同一批次的证据，联合推断：

- 分隔符：`,`、`\t`、`;`、`|`、`:`（可配置）
- 引号：`"`、`'` 或禁用
- 转义：双写引号（RFC 4180）、反斜杠或禁用
- 换行：`LF`、`CRLF`、`CR`
- 编码：UTF-8、UTF-16LE、UTF-16BE、ISO-8859-1（含 BOM 识别）

候选按可解释的分项评分排序，并同时返回数值证据与文字理由。列数稳定性有意义，但**不会压过合法的引号结构**：引号结构合法但列宽略差的候选，优先于列宽稳定但引号结构被破坏的候选。证据不足时返回歧义集合，而不是硬猜一个方言。

## 快速开始

```go
package main

import (
	"fmt"

	"example.org/dataeng/q0229"
)

func main() {
	samples := []dataeng.Sample{
		{Name: "a.csv", Data: []byte("id,name\n1,\"Alice, A.\"\n")},
		{Name: "b.csv", Data: []byte("id,name\n2,\"Bob, B.\"\n")},
	}

	result, err := dataeng.Infer(samples)
	if err != nil {
		panic(err)
	}
	if result.Ambiguous {
		fmt.Println("需要人工确认:", result.Ambiguities)
		return
	}

	d := result.Dialect()
	fmt.Printf("delimiter=%q quote=%q newline=%q encoding=%s width=%d\n",
		d.Delimiter, d.Quote, d.Newline, d.Encoding,
		result.Best.Evidence.DominantWidth)
	fmt.Println(result.Best.Reasons)
}
```

只需要一个答案时可用 `InferDialect`。证据不足时它返回最佳候选和 `ErrAmbiguous`，不会静默选择：

```go
dialect, err := dataeng.InferDialect(samples)
if errors.Is(err, dataeng.ErrAmbiguous) {
	// 调用 Infer 读取完整歧义集合，或补充样本后重试。
}
```

## 评分与排序

`Candidate` 提供：

- `Score`：总分，范围 0..1。
- `Components`：编码、分隔符、列宽、引号、转义、换行、覆盖率七项分数。
- `Evidence`：分隔符出现次数、引号字段数、嵌入分隔符/换行数、列宽直方图、换行计数、编码匹配数等。
- `Reasons`：可直接记录到采集日志的人类可读理由。
- `ValidQuotes`：该候选是否保留了合法引号结构。
- `QuotePriority`：引号证据层级（3=解析出引号字段且结构基本有效，2=合法但未使用引号，1=有引号字段但结构大部分损坏，0=忽略/无有效引号结构）。

默认权重偏重引号结构（`DefaultWeights`）。排序先看 `QuotePriority` 引号证据层级，同层再按加权总分和候选先验排序；因此即使无引号解析的列数更稳定，也不能压过合法引号结构：

```csv
a,b,"x,y"
c,d,"u,v"
```

正确结果是 3 列、`quote='"'`，而不是稳定但破坏引号结构的 4 列解析。

若样本中完全没有引号字符，库会把 RFC 风格的 `"` 作为常规默认（禁用引号仍是合法但略低先验的假设），避免锁定后正常带引号的新文件被误隔离。反斜杠转义同样支持无引号字段，例如 `a\,b,c`。

可通过函数式选项调整候选和阈值：

```go
result, err := dataeng.Infer(samples,
	dataeng.WithDelimiters(',', ';', '\t'),
	dataeng.WithQuotes('"', 0),
	dataeng.WithMinRecords(3),
	dataeng.WithAmbiguityMargin(0.03),
)
```

`Options` 也可直接传给 `InferWithOptions`。零值字段会补默认值，但 `MinRecords`、`MaxSampleBytes` 的零值保持“无限制/不截断”语义。

## 歧义集合

以下情况会让 `Result.Ambiguous == true`，并在 `Result.Ambiguities` 中返回按同样层级与分数排序的近邻候选：

- 非空记录太少（默认少于 2 条）。
- 引号外从未观察到分隔符（单列数据无法确定分隔符）。
- 最高分低于 `MinScore`，或编码证据太弱。
- 多个样本在编码、主导列数或换行风格上冲突。
- 操作上不同的候选分数差距小于 `AmbiguityMargin`。

仅引号字符或转义方式不同、但解析出的字段流完全相同的候选会被视为等价，不会制造无意义的歧义。

默认要求至少 2 条非空记录（可跨文件累计）；只有单行样本且确有把握时，可用 `WithMinRecords(1)` 放宽。

## 锁定、隔离与不漂移

`Result.Lock()` 发布不可变方言快照。默认拒绝锁定歧义结果；明确调用 `AllowAmbiguousLock()` 才会锁定最佳候选。锁可固定期望列数：

```go
lock, err := result.Lock(
	dataeng.WithColumns(3),
	dataeng.WithStrictNewline(true),
)
```

每个新文件用 `lock.Validate` 检查。任何违约都进入隔离分区，不修改锁：

```go
verdict := lock.Validate("new.csv", data)
if verdict.IsQuarantined() {
	// 写入隔离区；不要用该文件反向调整本批方言。
	for _, v := range verdict.Violations {
		log.Printf("%s: %s", v.Kind, v.Message)
	}
}
```

检查项包括编码/BOM、引号外的分隔符、引号结构、转义错误、换行风格和列宽。`AllowRagged`、`AllowBOMVariation`、`AllowEmpty` 等选项可放宽对应规则。

批量入口使用 `Batch`：

```go
batch, _ := dataeng.NewBatch(lock)
batch.Ingest("ok.csv", okData)       // accepted
batch.Ingest("bad.csv", badData)     // quarantined
fmt.Println(len(batch.AcceptedFiles()), len(batch.QuarantinedFiles()))
```

更完整的采集入口是 `Collector`：

```go
collector := dataeng.NewCollector()
_ = collector.AddFile("seed-1.csv", data1)
_ = collector.AddFile("seed-2.csv", data2)

result, err := collector.Lock()      // 推断并发布本批规则
if err != nil { /* ambiguous 或样本不足 */ }

// 锁定时会用新规则复核样本并放入 accepted/quarantined 分区；
// 此后 Add/Ingest 只做校验与隔离，不会重新推断。
verdict, _ := collector.IngestFile("late.csv", lateData)
```

锁定后再次调用 `Collector.Infer` 或 `Collector.Lock` 返回 `ErrAlreadyLocked`。

## 编码说明

- 自动识别 UTF-8/UTF-16 的 BOM，并剥离 BOM 后解析。
- 无 BOM 的 UTF-16 通过字节模式与文本合理性判断；识别不确定时可显式传 `WithEncodings(dataeng.EncodingUTF16LE)`。
- 非 UTF-8 且非 UTF-16 的字节按 ISO-8859-1 解码，因此不会因个别高位字节导致整批失败。
- UTF-32 不在支持范围内；检测到 UTF-32 BOM 时会拒绝推断，避免误当作 UTF-16。
- 不内置 GBK/GB18030 解码表，避免引入外部依赖；需要时请先转码为 UTF-8 再交给本库。

## 解析接口

已知方言后可直接解析：

```go
dialect := dataeng.Dialect{
	Delimiter:   ',',
	Quote:       '"',
	DoubleQuote: true,
	Newline:     "\n",
	Encoding:    dataeng.EncodingUTF8,
}
records, err := dataeng.Parse(data, dialect)
```

`Parse` 返回 `[]Record`，保留字段值与起始物理行号。`Lock.Parse` 先做严格一致性检查，再把隔离文件排除在结果之外。

## 测试

```bash
go test ./...
go test -race ./...
```
