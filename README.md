# logindex

为变长 UTF-8 日志建立行号与字节范围索引的 CLI，仅使用 Go 标准库。

## 功能

- **行/字节范围索引**：每行记录 `Num / Offset / Length / Term / Digest`（SHA-256），
  按 `\n` 切分（`\n` 不会出现在多字节 UTF-8 序列中，字节切分安全）。
- **追加增量更新**：`update` 重新哈希已索引前缀 `[0, Size)` 并与记录摘要比对；
  一致则只扫描追加部分（含未换行尾行的续接），不一致或文件被截断则返回
  `ErrStale` 拒绝复用旧索引。
- **搜索核源摘要**：`search` 对每个候选引用回读源文件字节并重算 SHA-256，
  摘要匹配才报告位置；任何不匹配即报错，绝不报告未核实的引用。

## 用法

```sh
logindex build  <logfile> [-index idxfile]   # 全量建索引（默认 <logfile>.lidx）
logindex update <logfile> [-index idxfile]   # 追加后增量更新；原段被改动则拒绝
logindex search <logfile> <pattern> [-index idxfile]
# 输出: 行号:字节偏移:长度:行内容
```

## 测试

索引扫描器实现为增量状态机（`Scanner.Write`），测试用随机切块与随机截断
同独立完整扫描参考实现核对引用位置；另覆盖追加增量与全量重建一致性、
原段改动/截断拒绝、搜索摘要核实。

实际运行结果（Go 1.27.1, linux/amd64）见下文 `go test ./...` 输出记录。

```
$ go test ./... -v
?   	logindex/cmd/logindex	[no test files]
=== RUN   TestScannerRandomChunking
--- PASS: TestScannerRandomChunking (0.01s)
=== RUN   TestRandomTruncation
--- PASS: TestRandomTruncation (0.02s)
=== RUN   TestBuildMatchesFullScan
--- PASS: TestBuildMatchesFullScan (0.00s)
=== RUN   TestAppendIncremental
--- PASS: TestAppendIncremental (0.00s)
=== RUN   TestModifyOriginalRejected
--- PASS: TestModifyOriginalRejected (0.00s)
=== RUN   TestTruncateRejected
--- PASS: TestTruncateRejected (0.00s)
=== RUN   TestSearchVerifiesDigest
--- PASS: TestSearchVerifiesDigest (0.00s)
=== RUN   TestSaveLoadRoundtrip
--- PASS: TestSaveLoadRoundtrip (0.00s)
PASS
ok  	logindex/index	0.088s
```
