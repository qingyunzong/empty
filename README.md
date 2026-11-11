# q270 — 仅解析的 TLS ClientHello 读取组件

`example.com/dlks/q270` 为 TLS 入口路由服务提供可导入的 ClientHello
读取器。组件只按线路结构解析协议字段，不进行任何解密或密钥推导。

## 协议模型

- 记录头：内容类型 1 字节 + 版本 2 字节 + 长度 2 字节（共 5 字节）。
- 握手头：消息类型 1 字节 + 长度 3 字节（共 4 字节）。
- 一条握手消息可跨多条记录；一条记录也可承载多条（或部分）握手消息，
  读取器按握手字节流重组，两种布局都支持，且握手头自身也可跨记录。

## 解析与校验

解析并暴露：会话 ID、密码套件列表、压缩方法列表、扩展块声明长度、
唯一 SNI 主机（`server_name` 扩展中的 `host_name`）与 ALPN 列表。

校验失败时返回带哨兵错误的 `error`（可用 `errors.Is` 匹配），且绝不调用路由器：

- `ErrDuplicateExtension`：同一扩展类型重复出现（SNI/ALPN 等一律拒绝）。
- `ErrLengthOutOfBounds`：任一嵌套长度越出其外层结构，或扩展块未精确填满消息尾部。
- `ErrMessageTooLarge`：单条握手消息或总缓冲超出 `Config` 预算。
- `ErrUnexpectedRecord` / `ErrUnexpectedHandshake`：ClientHello 之前出现
  非握手记录或首条握手消息不是 ClientHello。
- `ErrInvalidClientHello`：边界自洽但语义非法（如多个 SNI 主机、空 ALPN 名）。

数据不完整时 `Feed` 返回 `(nil, nil)` 并保留全部已收字节，等待后续切块。

## 路由与重放契约

- 路由器（`Router` / `RouterFunc`）只在整条 ClientHello 重组并校验通过后
  恰好调用一次；任何半截或畸形输入都不会提前触发。
- `ClientHelloInfo.Raw` 是已消费线路字节（含记录头）的独立拷贝，
  供下游原样重放；`Unconsumed()` 返回未消费的尾随字节（后续消息、
  后续记录或半截记录），一个字节都不丢弃，可交给新的读取器继续解析。

## 用法

```go
r := q270.NewReader(q270.Config{
    MaxHandshakeMessage: 16 * 1024, // 0 时使用默认预算
    MaxBuffered:         64 * 1024,
    Router: q270.RouterFunc(func(info q270.ClientHelloInfo) {
        route(info.ServerName, info.ALPN)
        replay(info.Raw)
    }),
})

for {
    n, err := conn.Read(buf)
    if err != nil { /* ... */ }
    info, err := r.Feed(buf[:n]) // 可按任意大小切块，逐块喂入
    if err != nil { /* 协议违规，哨兵错误可匹配 */ }
    if info != nil {
        tail := r.Unconsumed() // 保留尾随字节，交给下一阶段
        break
    }
}
```

## 测试

`go test ./...` 覆盖 1 字节起的各种切块、跨记录/跨握手头重组、
单记录多消息、尾随记录重放、重复扩展、各类嵌套坏长度、预算越界，
并断言所有畸形路径都不触发路由器且不丢失尾随字节；`-race` 通过，
语句覆盖率约 95%。
