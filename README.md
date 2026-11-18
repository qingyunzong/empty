# 网关会话映射表

并发安全的 Go 五元组会话映射库，供网关收包路径直接调用。

## 能力

- 为出向五元组分配外部端口，端口池内不会重复占用。
- UDP 映射按空闲时间刷新；TCP 和其他协议可配置独立超时。
- 超时回收与建连在同一把锁内完成；端口池耗尽时会原子地回收已超时映射后重试。
- 每次端口分配生成单调递增的代次；旧 `Mapping`/`BindingKey` 无法释放复用该端口的新会话。
- ICMPv4/ICMPv6 差错同时支持内嵌 NAT 前（内网源）和 NAT 后（外部地址/映射端口）五元组；
  后 NAT 形式还会核对协议与远端端点，只删除对应会话，不影响复用同一端口但远端不同的新会话。
- 全部创建、刷新、显式删除、超时回收、ICMP 删除和分配失败均有计数，且满足 `Created == Active + Removed + Expired + ICMPRemoved`。

## 收包路径

```go
m, err := formal.New(formal.Config{
    PortMin:    32768,
    PortMax:    60999,
    UDPTimeout: 30 * time.Second,
    ExternalIP: netip.MustParseAddr("198.51.100.10"), // 可选，用于校验 NAT 后 ICMP 源地址
})
if err != nil {
    return err
}

// 出向包：查找或创建映射，并刷新空闲超时。
mapping, err := m.Map(outboundTuple)

// 入向包：按外部目的端口找到原始五元组。
// 如需把入向流量也算作活动，再调用 RefreshPort。
inbound, ok := m.LookupPort(dstPort)
if ok {
    m.RefreshPort(dstPort)
}

// 原始 IP 包（不含以太网头）：解析五元组或 ICMP 差错。
tuple, err := formal.ParseTuple(ipPacket)
inner, err := formal.ParseICMPError(icmpPacket)
removed, err := m.HandleICMPErrorPacket(icmpPacket)

// 周期回收；返回本次回收数量。
expired := m.Expire(time.Now())
```

`Map` 是“查找或创建并刷新”，`Lookup`/`LookupPort` 只读不刷新，
`Refresh`/`RefreshPort` 用于显式续期。所有方法都有带 `At` 后缀的版本，
可传入确定性的时间戳，便于收包路径使用包时间或测试。

## 代次与释放

```go
old, _ := m.Map(tuple)
// ... old 超时，同一端口被新会话复用 ...
if !m.RemoveBinding(old.Key()) {
    // 代次已过期，没有误删新会话
}
```

`Mapping.Key()` 绑定“端口 + 代次”。`RemoveBinding` 只在二者都仍指向当前
占用者时释放，因此建连与超时回收交错时不会出现端口串用。

## 验证

```sh
go test ./...
go test -race ./...
```

测试包括：

- 12 种包操作、长度 5 的完整序列穷举，逐步对照独立的朴素五元组映射表，
  核对五元组、端口、代次、到期时间、快照和全部计费字段。
- 建连与同一截止时刻的超时扫描并发交错 500 次，验证每次都得到新代次且旧句柄失效。
- ICMPv4/ICMPv6 原始报文解析、端口复用后的陈旧 ICMP 隔离、协议独立超时和端口耗尽回收。
- 多 goroutine 压测及不变量检查。
