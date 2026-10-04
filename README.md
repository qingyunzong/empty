# tmplex

增量式模板词法库，仅依赖 Go 标准库。

## 语言

模板由字面文本与 `{{ ... }}` 表达式混合而成：

- 表达式内括号 `()` 可任意嵌套；`}}` 仅在括号深度为 0 时结束表达式，
  深度大于 0 时按普通 `Punct` 处理。
- 表达式内支持字符串字面量（`'...'` / `"..."`，反斜杠转义）；
  字符串内的 `}}` 结束标记无效，只是字符串内容。
- 未终止的字符串/表达式在 EOF 处按已有输入收尾。

## 增量扫描与模式栈

通过 `Feed([]byte) []Token` 以任意大小的块喂入输入，`Close() []Token`
收尾。模式栈（text / expr / string，含括号深度、引号种类、转义状态）
保存在 `Lexer` 结构体内，块在任意字节边界中断都不会丢失扫描状态。
多字节定界符（`{{`、`}}`）或 token（标识符、数字、字符串）被块边界
切开时，扫描器等待后续输入再提交，保证 maximal munch 与切块无关。

每个 `Token` 携带原输入流中的半开字节区间 `[Start, End)`，
token 区间连续且完整覆盖输入。

## 测试

- 单元测试：字符串屏蔽 `}}`、转义引号、嵌套括号、括号内 `}}`、
  未终止构造、孤立花括号、数字等。
- 一致性核对：语料逐字节二分切分、逐字节喂入、300 个随机种子的
  随机模板 + 随机切块，均与一次性完整扫描的 token 流逐一相等，
  并校验 token 区间无缝覆盖原始输入。

## 实际测试结果

```
$ go test ./...
ok  	tmplex	0.010s

$ go test -race -count=1 -v ./...
=== RUN   TestBasic ... --- PASS
=== RUN   TestStringHidesCloseMarker ... --- PASS
=== RUN   TestSingleQuotedStringHidesCloseMarker ... --- PASS
=== RUN   TestEscapedQuoteKeepsStringOpen ... --- PASS
=== RUN   TestEscapedBackslashBeforeQuote ... --- PASS
=== RUN   TestNestedParens ... --- PASS
=== RUN   TestCloseMarkerInsideParensIsPunct ... --- PASS
=== RUN   TestUnterminatedStringRunsToEOF ... --- PASS
=== RUN   TestUnterminatedExpression ... --- PASS
=== RUN   TestLoneBracesInText ... --- PASS
=== RUN   TestEmpty ... --- PASS
=== RUN   TestNumbers ... --- PASS
=== RUN   TestTwoWaySplitEverywhere ... --- PASS
=== RUN   TestByteAtATime ... --- PASS
=== RUN   TestRandomChunkingMatchesFullScan ... --- PASS
=== RUN   TestFeedAfterClosePanics ... --- PASS
PASS
ok  	tmplex	1.049s
```
