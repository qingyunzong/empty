# streamlex

基于有限自动机（DFA）表的流式词法分析库，仅使用 Go 标准库。

## 语义

- **竞争裁决**：多条规则竞争时选最长匹配；长度相同按规则声明顺序取先。
- **不提前发 token**：块尾的匹配仍可能随后续输入延长（如块尾 `"ab"` 可能是
  `"abc"` 的前缀），因此只有两种时刻才敲定 token：
  1. 所有规则的自动机都走入死状态——匹配不可能再延长，立即发出；
  2. `End` 结束信号——流已完结，此刻才确定尾项。
- **规则即自动机表**：`Rule{Start, Trans []map[byte]int32, Accept []bool}`，
  缺失的转移表示死路；`Literal(name, s)` 可构造字面串规则。
- **错误**：无任何规则可匹配时返回 `*Error`，`Offset` 为无法成 token 的
  起始绝对偏移；已切出的 token 照常返回。

## API

```go
lx := streamlex.New(rules...)   // 规则按声明顺序给出
toks, err := lx.Feed(chunk)     // 反复喂入输入块
tail, err := lx.End()           // 结束信号，冲刷尾项并关闭
```

`LexAll(rules, src)` 是一次性全串匹配的参照实现，用于对照验证。

## 测试

- `lexer_test.go`：块尾不提前发 token、End 定尾项、最长匹配与声明序、
  token 绝对偏移、错误位置、End 后关闭语义、空输入。
- `exhaustive_test.go`：枚举短输入与全部 2^(n-1) 种切块，逐一对照全串匹配；
  另有固定种子的长输入随机切块对照。

## 实测结果（go1.27.1 linux/amd64，2026-10-05）

```
$ go test ./... -v -count=1
=== RUN   TestExhaustive
=== RUN   TestExhaustive/literals
    exhaustive_test.go:97: checked 3280 inputs x all chunkings
=== RUN   TestExhaustive/keyword-vs-ident
    exhaustive_test.go:97: checked 3906 inputs x all chunkings
--- PASS: TestExhaustive (0.68s)
    --- PASS: TestExhaustive/literals (0.52s)
    --- PASS: TestExhaustive/keyword-vs-ident (0.16s)
=== RUN   TestRandomizedLongInputs
--- PASS: TestRandomizedLongInputs (0.04s)
=== RUN   TestNoEarlyEmitAtChunkBoundary
--- PASS: TestNoEarlyEmitAtChunkBoundary (0.00s)
=== RUN   TestEndDeterminesTail
--- PASS: TestEndDeterminesTail (0.00s)
=== RUN   TestLongestMatchThenDeclarationOrder
--- PASS: TestLongestMatchThenDeclarationOrder (0.00s)
=== RUN   TestTokenPositions
--- PASS: TestTokenPositions (0.00s)
=== RUN   TestErrorOffset
--- PASS: TestErrorOffset (0.00s)
=== RUN   TestClosedAfterEnd
--- PASS: TestClosedAfterEnd (0.00s)
=== RUN   TestEmptyInput
--- PASS: TestEmptyInput (0.00s)
PASS
ok  	streamlex	0.734s
```

穷举规模：`literals` 规则集（"ab"/"abc"/"a"）在字母表 {a,b,c} 上枚举
长度 ≤7 的全部 3280 个输入 × 各自全部切块；`keyword-vs-ident` 规则集
（"if" 与 [a-z]+）在字母表 {a,b,f,i,z} 上枚举长度 ≤5 的全部 3906 个输入
× 各自全部切块。所有切块流式结果与全串匹配在 token 序列及错误偏移上
完全一致。
