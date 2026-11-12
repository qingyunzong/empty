# 分块多部分响应接入

网页采集服务需要可导入的Go多部分响应解析组件。调用方提供只含ASCII字母数字的非空边界B、分块字节流、每部分正文上限和头部总字节上限。输入必须以--B加CRLF开始；每部分由零或多行Name: Value头、空行和正文组成，头名由ASCII字母数字或连字符构成且不区分大小写，冒号后必须有一个空格，值为不含CR或LF的ASCII字节，拒绝重复Content-ID。正文后的CRLF--B加CRLF开始下一部分，CRLF--B--加CRLF结束整个输入；分隔符前的CRLF不属于正文，结束后不得有数据。仅完整分隔行生效，正文内边界前缀须保留，空正文允许。每部分暂存到调用方事务落点，全部解析完才提交；截断、超限或流失败须撤销，取消时关闭输入。用自行编码夹具逐字节切块，验证前缀跨块、空正文、伪结束边界及失败不发布。

## 用法

入口为 `Parse`，调用方提供输入流、边界、字节上限与事务落点 `PartSink`：

```go
n, err := dataeng.Parse(ctx, rc, "BX9",
	dataeng.Limits{MaxPartBody: 1 << 20, MaxHeaderBytes: 1 << 16},
	sink)
```

- `PartSink.BeginPart` 为每个部分返回一个暂存写入器；解析器在全部成功后调用一次 `Commit`，任何失败路径恰好调用一次 `Abort`。
- 解析器按流处理，不缓存整段正文；正文内出现的边界前缀、伪结束边界都会原样保留，只有完整分隔行才生效。
- 错误哨兵：`ErrTruncated`、`ErrLimitExceeded`、`ErrDuplicateContentID`、`ErrInvalidBoundary`、`ErrMalformed`，配合 `errors.Is` 判断。
- `ctx` 取消时解析器关闭输入流以解除阻塞读取，撤销事务并返回 `ctx` 的错误。

测试用自行编码的 `buildMessage` 夹具配合逐字节/随机切块读取器，覆盖前缀跨块、空正文、伪结束边界以及失败不发布等场景，运行 `go test ./...`。
