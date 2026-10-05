# bracketdiag

源码括号诊断库（仅使用 Go 标准库）。词法分析时忽略字符串与注释中的
括号，维护括号匹配对及未配对位置；支持增量编辑，编辑可能改变后续
词法状态，增量结果保证与全量扫描一致。

## 词法规则

- 行注释 `//`、块注释 `/* */`（可跨行，不嵌套）
- 字符串 `"..."`、字符 `'...'`（支持 `\` 转义）、原始字符串 `` `...` ``（可跨行）
- 行尾恢复：行注释、未闭合的字符串/字符在行尾结束；块注释与原始
  字符串的状态延续到下一行

## 诊断

- `Pairs`：匹配括号对（按右括号出现顺序）
- `UnmatchedOpens` / `UnmatchedCloses`：未配对括号位置
- `EarliestError`：最早的未配对括号位置（无错误为 -1）

## 库用法

```go
doc := bracketdiag.NewDocument(src)
_ = doc.Edit(start, end, text) // 增量更新
d := doc.Diagnostics()         // 与 bracketdiag.Analyze(doc.Text()) 一致
```

## CLI

```sh
go run ./cmd/brackedit check <file>           # 全量扫描，输出诊断 JSON
go run ./cmd/brackedit edit [-verify] <file>  # stdin 逐行读入编辑并增量应用
```

编辑输入为 JSON 行：`{"start":10,"end":12,"text":"("}`（start==end 为
插入，text 为空为删除）。`-verify` 每步将增量结果与全量扫描核对。

## 测试

```sh
go test ./...
```

随机测试以切块组合（括号、引号、注释定界符、代码片段）构建文本，
并执行随机插入/删除/替换，每步将增量维护的匹配对与最早错误同
全量扫描对拍。
