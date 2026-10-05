# brackdiag

源码括号诊断库：词法分析时忽略字符串字面量（`"..."`、转义）、字符字面量
（`'...'`）、原始字符串（`` `...` ``）、行注释（`//`）与块注释（`/* */`，可跨行）
中的括号，维护 `()[]{}` 的匹配对、未配对括号位置及最早错误位置。

## 结构

- `brackdiag/lex.go` — 行级词法器；仅块注释与原始字符串的状态跨行传递。
- `brackdiag/document.go` — `Document`：按行缓存词法结果；`Edit(off, del, insert)`
  后只从受影响行重扫，直到某行的缓存起始状态与新状态一致（编辑不再影响后续词法状态）。
- `brackdiag/match.go` — 栈式括号匹配；`Scan(text)` 为独立的全扫描参考实现。
- `cmd/brack` — 编辑 CLI。

## CLI

```sh
go build -o brack ./cmd/brack
brack check <file>                              # 全扫描诊断
brack edit <file> <offset> <deleteLen> <text>   # 内存中编辑后增量诊断（-w 写回文件）
```

输出匹配对（开/闭偏移）、未配对括号及最早错误偏移。

## 一致性保证

`Document` 增量编辑后的诊断结果与对当前文本执行 `Scan` 全扫描完全一致，
由以下测试保证：

- `TestRandomEdits` — 30 个随机种子，每个 300 次随机插入/删除/替换
  （片段含引号、转义、注释符、括号），每次编辑后比对全扫描。
- `TestChunkAppend` / `TestChunkPrepend` — 按 1..9 字节切块顺序追加或逆序前插，
  覆盖字符串/转义/注释符被切块边界劈开的情形，每块插入后比对全扫描。
- `TestChunkRecombine` — 随机切块、随机顺序随机位置重组，再随机删空，逐步比对。
- `TestEditShiftsLexState` — 删除 `/*`、插入 `"` 等改变后续词法状态的编辑。
- `TestScanBasics` — 词法与匹配的表驱动单元测试。

## 测试结果

```
$ go test ./...
ok  	brackdiag/brackdiag	0.028s
?   	brackdiag/cmd/brack	[no test files]
```

全部 6 个测试通过（go1.27.1 linux/amd64，仅使用标准库）。
