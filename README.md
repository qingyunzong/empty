Webhook接入服务需要Go签名中间件，租户由路由绑定，不能相信正文里的租户字段。签名覆盖时间戳、nonce、原始请求体SHA256，采用HMAC-SHA256；时钟容差由调用方配置。流式读取正文受字节上限约束，验签通过后才以原字节交给处理器，同租户nonce的占用与业务提交通过注入事务接口原子完成。并发重复只允许一次提交；测试错误租户密钥、签名前后字节变动、回滚后重试及过期nonce回收边界。

## 设计要点

- 租户只来自路由（默认读取 `{tenant}` 路径通配符，可用 `Config.ResolveTenant` 自定义），请求正文中的租户字段完全不参与鉴权。
- 签名为 HMAC-SHA256，hex 编码，签名载荷：
  `fmt.Sprintf("%d\n%s\n%s", timestamp, nonce, hex(sha256(body)))`，
  即时间戳、nonce 与原始请求体的 SHA-256 摘要；常量时间比较防时序攻击。
- `Config.ClockTolerance` 由调用方配置，时间戳为 Unix 秒，超出容差返回 401。
- 正文通过 `io.LimitReader` 流式读取，缓冲字节数硬限制在 `Config.MaxBodyBytes`，超限返回 413。
- 同一份字节先用于验签，验签通过后原样传给 `MessageHandler`，处理器不接触 `http.ResponseWriter`。
- `TransactionManager.WithinTx` 在一个事务内完成 nonce 占用与业务提交：重复 nonce 返回 `ErrDuplicateNonce`（409），处理器报错则回滚并释放 nonce，允许同 nonce 重试。
- 过期 nonce 按 `Config.NonceTTL` 惰性回收，`MemoryTransactionManager.ReapExpired` 提供主动回收；到期判定为 `now >= expiresAt`（恰好在到期时刻即可回收）。

## 用法

```go
keys := q245.NewMemoryTenantKeyStore(map[string][]byte{
    "tenant-a": []byte("tenant-secret"),
})
txMgr := q245.NewMemoryTransactionManager(nil) // 生产环境替换为数据库实现

mw, err := q245.New(q245.Config{
    Keys:      keys,
    TxManager: txMgr,
    Handler: q245.MessageHandlerFunc(func(ctx context.Context, tx q245.Tx, tenant string, body []byte) error {
        // 在持有 nonce 占用的事务内完成业务写入，返回 error 会触发回滚。
        return nil
    }),
    ClockTolerance: 30 * time.Second,
    MaxBodyBytes:   1 << 20,
    NonceTTL:       10 * time.Minute,
})
if err != nil { /* 配置校验失败 */ }

mux := http.NewServeMux()
mux.Handle("POST /webhooks/{tenant}", mw)
```

客户端生成签名：

```go
sig := q245.Sign(secret, time.Now().Unix(), nonce, body)
req.Header.Set(q245.HeaderTimestamp, strconv.FormatInt(ts, 10))
req.Header.Set(q245.HeaderNonce, nonce)
req.Header.Set(q245.HeaderSignature, sig)
```

## 文件

- `middleware.go`：中间件、签名/验签、限长读取、上下文访问器。
- `store.go`：`TenantKeyStore`、`Tx`、`TransactionManager` 接口。
- `memory_store.go`：内存版密钥库与事务管理器（含 nonce 统计与回收）。
- `errors.go`：哨兵错误。
- `middleware_test.go`：错误密钥、字节/签名篡改、回滚重试、并发去重、过期回收边界等测试。
