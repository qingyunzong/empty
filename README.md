# addrlst

地址列表解析 CLI：支持双引号字符串、反斜杠转义、可嵌套的圆括号注释；
逗号只在顶层分隔地址；不做任何真实域名/语法校验（纯词法解析）。

## 构建与测试

```sh
go test ./...
go build ./cmd/addrlst
```

## 用法

```sh
addrlst [-chunk N] [file ...]   # 无文件参数时读 stdin
```

每个地址输出一行 JSON：

```json
{"address":"\"Doe, John\" <john@x>","start":0,"end":30}
```

- `address`：去掉注释后的地址文本（引号字符串原样保留）。
- `start` / `end`：地址在原始输入中的字节跨度 `[start, end)`，
  不含首尾空白与分隔逗号，但覆盖地址内部的注释。

`-chunk N` 按 N 字节一块流式读取（默认 4096）；`-chunk 0` 整读。
两种方式解析结果完全一致（由 `TestStreamingMatchesWhole` 对照验证）。

## 解析规则

- 顶层 `,` 分隔地址；引号或注释内的逗号不分隔。
- `"..."` 引号字符串内 `\` 转义任意下一字符。
- `(...)` 注释可嵌套，注释内 `\` 转义任意下一字符（如 `\)`）。
- 未闭合的引号在物理行末（`\r` 或 `\n`）自动结束，不会吞掉后续行。
- 未闭合的注释一直延续到输入末尾。
- 去注释时不改动其余字符，仅整体修剪首尾空白；
  内容为空的条目（空段或纯注释段）被跳过。

## 作为库使用

```go
addrs := addrlst.ParseString(`a@x (note), "Doe, John" <j@y>`)
addrs, err := addrlst.ParseReader(r, 4096) // 流式
// 或增量：p := addrlst.NewParser(); p.Write(chunk); ...; p.Close()
```
