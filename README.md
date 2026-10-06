# addrlist

流式地址列表解析器与 CLI。支持引号、反斜杠转义、可嵌套括号注释；
逗号仅在顶层分隔地址；不验证域名合法性。

## 语法规则

- `,` 仅在顶层分隔地址；引号内、注释内的逗号不分隔。
- `( ... )` 为注释，可嵌套，输出中移除。
- `\` 转义下一字节（注释内、引号内、顶层均生效）；转义字节原样保留，不反转义。
- 未闭合的 `"` 隔离到物理行末：遇 `\n` 引号状态自动结束，不会吞掉后续输入。
- 未闭合的注释持续到输入结束。
- 空地址（连续逗号、纯注释/空白段）被跳过。

## 输出

每个地址一行：`[start:end] text`

- `text`：去除注释、修剪两端空白后的地址文本（引号与转义原样保留，可能含内部换行）。
- `start`/`end`：地址在原始输入中的字节跨度（首个与最后一个非空白、非注释字节）。

## 使用

```sh
go build ./cmd/addrlist
echo '"Doe, John" <john@x> (work), jane@y' | ./addrlist
# [0:20] "Doe, John" <john@x>
# [29:35] jane@y

./addrlist file1.txt file2.txt   # 或从文件读取
```

## 库

```go
p := addrlist.NewParser(func(a addrlist.Address) { /* ... */ })
p.Write(chunk1) // 任意大小的块
p.Write(chunk2)
p.Close()
```

`Parser.Write` 支持任意切块流式输入，结果与整读一致（测试覆盖：
`TestChunkedMatchesWhole`、`TestRandomChunkBoundaries`）。

## 测试

```sh
go test ./...
```
