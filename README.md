# 站点归档抓取包

`dataeng` 是可导入的 Go 抓取包，按广度优先顺序归档同一组允许主机名下的页面。
仅依赖 Go 标准库。

## 入口

```go
crawler := dataeng.NewCrawler(http.DefaultTransport) // 传输层可替换
result := crawler.Crawl(
    "http://example.com/",
    map[string]bool{"example.com": true}, // 允许主机名集合
    50,                                   // 正整数请求上限
)
```

`NewCrawler(nil)` 等价于使用 `http.DefaultTransport`；测试或离线场景可注入任意
`http.RoundTripper`。

## 抓取与去重规则

- 广度优先：页面链接按文档顺序追加到队尾，依次出队。
- 仅抓取 `http` 或 `https`；其他 scheme 记入拒绝原因。
- 去重 URL 为去除片段（fragment）并将主机名转小写后的完整 URL；主机名比较不
  区分大小写，允许集合中的端口会被忽略。
- 每次请求前都检查允许集合，重定向目标在跟随前同样检查；跨域重定向不会发出
  请求，而是记录 `host not allowed`。
- 每次 HTTP 请求（包括每一次重定向跟随）都计入上限；重定向在当前页面的请求
  链内按顺序跟随。
- 重定向目标若已请求，立即停止该链并记录 `redirect target already requested`
  （重定向循环即由此终止）；若仅已入队，则把队列项标记为已处理并立即跟随，
  后续出队时跳过。
- 达到上限后不再发请求：未处理的队列项进入 `Result.Pending`，当前请求链中尚未
  请求的跳转目标进入 `Result.PendingRedirects`。
- 仅对状态码 2xx 且 `Content-Type` 为 `text/html` 的最终响应提取链接；相对地址
  以最终响应 URL 解析；非法 URL 记录原因后继续，不中断抓取。

## 返回值

`Result` 包含：

- `Visits`：请求链（初始 URL、最终 URL、状态码、传输错误、页面链接），按 BFS
  顺序排列。
- `Edges`：引用关系，`From` 为最终响应 URL，`To` 为规范化后的绝对 URL。
- `Rejects`：未请求的 URL 及拒绝原因（`Reason*` 常量）。
- `Pending`：达到上限时仍未处理的队列。
- `PendingRedirects`：达到上限时当前链中未请求的重定向目标。

## 测试

沙箱环境禁止绑定套接字，因此测试通过实现 `http.RoundTripper` 的内存路由模拟
本地 HTTP 服务，覆盖跨域跳转不请求、重定向循环、相对链接、请求上限、仅入队即
跟随等场景：

```sh
go test ./...
go test -race ./...
```
