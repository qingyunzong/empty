# 递归解析缓存库（formal）

供递归解析服务查询路径调用的 DNS 消息缓存，纯标准库实现。

## 缓存语义

- 正向记录：应答按 `(规范名称, 类型)` 分组为独立 RRSet 条目，组内取最小 TTL 统一到期；TTL 为 0 不缓存。
- NXDOMAIN：按名称缓存（哨兵 QTYPE），对该名称的任意查询类型生效。
- NODATA：`NoError` 且无回答时按 `(名称, 请求类型)` 缓存，不影响同一名称的其他类型。
- 否定 TTL：遵循 RFC 2308，取权威区 SOA 自身 TTL 与 SOA `MINIMUM` 的较小值；应答未携带 SOA 时不缓存，可用 `WithMaxNegativeTTL` 封顶。
- CNAME 链：链上每个 RRSet 是独立条目、独立到期；任一跳 TTL 到期只移除该跳，其余跳保留，重查时从最早缺失的环节继续拼装。
- 名称键：按 RFC 4343 做 ASCII 大小写归一化，不同大小写形式共享缓存键；应答中的名称与 CNAME 目标保留权威返回的原始大小写展示。
- 时间来源：`Clock` 接口抽象，生产用 `SystemClock`，测试用可手动推进的 `VirtualClock`，精确验证命中/到期/重查边界。
- `SERVFAIL` 等非 `NoError/NXDomain` 响应不缓存。

## 查询路径

`Resolver.Lookup` 先查缓存，未命中才向 `Authority` 重新查询并回填；回填后从缓存重放应答，使所有返回 TTL 统一折算为剩余秒数。`MockAuthority` 可在测试中替换区数据（`ReplaceZone`/`Remove`）并统计查询次数，用于验证权威区变更只在对应 TTL 到期后才被观察到。

## 测试

`go test ./...` 运行全部用例（含 `-race` 竞态检测），覆盖正向命中与到期、NXDOMAIN/NODATA、SOA 否定 TTL、CNAME 链独立失效、大小写共享键、区变更边界与 CNAME 环保护。
