# q225 — HTTP 请求正文组件

供 HTTP 网关连接处理器调用的 Go 请求正文解析组件，精确返回消费到的字节位置，
保证同连接流水线请求的边界不被吞掉。

## 入口

- `NewDecoder(header, limits)`：推送式背压状态机，`Decoder.Feed(in)` 返回
  `(payload, consumed, done, err)`。处理器按自己的节奏喂入连接字节，未消费的
  字节原样留给下一请求；`Consumed()` 给出消息结束的精确偏移。
- `NewBodyReader(r, header, limits)`：在 `Decoder` 之上封装的 `io.ReadCloser`，
  连接读中多读到的下一请求字节通过 `Leftover()` 原样返回。

## 帧规则

- 只接受二者之一：单个规范 `Content-Length`（纯十进制、无空白/折叠/逗号列表），
  或唯一标记为 `chunked` 的单个 `Transfer-Encoding`。
- 两种帧并存、重复 `Content-Length`、重复 `Transfer-Encoding` 及其他传输编码
  （identity、gzip、逗号列表、带参数等）在构造时即拒绝。
- chunked：块长为十六进制；块扩展按 token 或带引号字符串参数解析，引号内的
  分号不分割参数；所有行尾严格要求 CRLF，孤立 CR/LF 即报错。
- 零块后解析有界尾部字段，拒绝名为 `Content-Length`、`Transfer-Encoding`、
  `Host`、`Trailer` 的尾部字段，并限制尾部字节数与字段数。
- 任何协议错误都会“毒化”连接：后续调用返回匹配 `ErrPoisoned` 的错误，处理器
  必须关闭连接、不得复用。

## 背压与边界

- `Feed` 不做内部缓冲读，只处理调用方给出的字节，天然支持每字节喂入。
- 消息结束时 `done=true` 当次即停，`consumed` 之后的字节（下一请求）不被触碰。
- 主体大小、尾部大小/字段数、块行长度均受 `Limits` 约束（零值字段回退到
  `DefaultLimits`）。

## 验证

测试覆盖每字节切块、任意切分点一致性、引号内分号、伪零块（如 `10`/`00`）、
截断与 EOF、流水线拼接请求、严格 CRLF、尾部禁名与限额，以及错误后连接不可复用：

```sh
go test -race ./...
go vet ./...
```
