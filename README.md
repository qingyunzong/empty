爬虫的HTTP适配层要接入Go缓存组件，调用方传请求、响应头和可失败的正文流。缓存按URL及Vary指定的请求头区分；304只能刷新实际发起条件请求时命中的版本，同URL的新响应若先提交，迟到304不得覆盖它。正文读完且校验长度后才原子可见，Vary:*和no-store不得持久保存。提供注入时钟与内存传输适配器，用并发响应、正文中断和Vary变化验证版本选择及资源关闭。

## 组件

- `clock.go`：`Clock` 接口、`SystemClock` 与可手动推进的 `FakeClock`，驱动存储时间与新鲜度判断。
- `cache.go`：并发安全的内存缓存。键为 URL + `Vary` 选中的请求头值；`Store` 读完正文并校验 `Content-Length` 后才原子发布；`Cache-Control: no-store` 与 `Vary: *` 一律不持久化；`Revalidate` 只刷新发起条件请求时命中的具体条目，条目已被同 URL 的新响应替换时返回 `ErrEntryGone`，迟到 304 不会覆盖新内容。
- `transport.go`：`CachingTransport`（`http.RoundTripper`），新鲜命中直接返回，陈旧命中携带 `ETag`/`Last-Modified` 发起条件请求，304 合并响应头并保留原正文。
- `memorytransport.go`：进程内 `MemoryTransport` 测试适配器，按 URL 工厂产出响应并统计正文打开/关闭，附带可阻塞正文流用于原子可见性测试。

## 验证

`go test -race ./...` 覆盖 Vary 版本选择与变化、no-store / Vary:* 拒绝持久化、正文读取中断与长度不符时的资源关闭与零发布、并发响应下的原子可见性，以及迟到 304 与新响应的竞争语义。
