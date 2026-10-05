# logindex

索引变长 UTF-8 日志的 CLI：为每行记录字节范围（偏移 + 长度），仅使用 Go 标准库。

## 设计

- **行/字节范围索引**：索引只覆盖由完整行（`\n` 结尾）构成的最长前缀
  `IndexedLen`；每行记录 `Offset`/`Length`（含换行符）。末尾不完整的行不进入索引，
  因此追加写入延续末行时无需重建。
- **追加增量可用**：`Update` 先核对已索引前缀的 SHA-256 摘要，一致则只扫描
  新增字节并增量扩展索引。
- **原段被改动则拒绝**：已索引区域被修改（摘要不匹配）或文件被截断
  （大小 < `IndexedLen`）时，`Update`/`Search` 返回 `ErrSourceChanged`，
  旧索引被拒绝且不被改写。
- **搜索核源摘要**：`Search` 先用当前源文件重算前缀摘要验证索引，命中行
  再从源文件按字节范围读回确认；索引之后追加的完整行与未换行尾巴
  直接扫描源文件补齐，保证结果完整。

## 用法

```sh
logindex [-i indexfile] build  <log>            # 全量建索引（默认 <log>.idx）
logindex [-i indexfile] update <log>            # 增量更新；原段改动/截断则拒绝（退出码 2）
logindex [-i indexfile] search <log> <query>    # 核源摘要后输出 行号:偏移+长度: 内容
logindex [-i indexfile] stats  <log>            # 行数、索引字节数、前缀摘要
```

## 测试

索引位置以朴素全扫描为参照核对：随机切块（1–257 字节）逐块追加并增量更新，
每一步都与全扫描参照比对；篡改与截断用例验证旧索引被拒绝；搜索引用位置
（含随机字节子串、多字节 UTF-8 查询）与全扫描逐一比对。

实际运行结果（Go 1.27.1，linux/amd64，`go test -v -count=1 ./...`）：

```
=== RUN   TestBuildMatchesFullScan
--- PASS: TestBuildMatchesFullScan (0.01s)
=== RUN   TestBuildEdgeCases
--- PASS: TestBuildEdgeCases (0.00s)
=== RUN   TestIncrementalUpdateOnAppend
--- PASS: TestIncrementalUpdateOnAppend (0.00s)
=== RUN   TestRandomChunkedAppends
--- PASS: TestRandomChunkedAppends (0.11s)
=== RUN   TestUpdateRejectsModifiedPrefix
--- PASS: TestUpdateRejectsModifiedPrefix (0.00s)
=== RUN   TestUpdateRejectsTruncation
--- PASS: TestUpdateRejectsTruncation (0.00s)
=== RUN   TestSearchMatchesFullScan
--- PASS: TestSearchMatchesFullScan (0.09s)
=== RUN   TestSearchSeesUnindexedTail
--- PASS: TestSearchSeesUnindexedTail (0.00s)
=== RUN   TestUTF8LineBoundaries
--- PASS: TestUTF8LineBoundaries (0.00s)
=== RUN   TestSaveLoadRoundTrip
--- PASS: TestSaveLoadRoundTrip (0.00s)
PASS
ok  	logindex	0.222s
?   	logindex/cmd/logindex	[no test files]
```
