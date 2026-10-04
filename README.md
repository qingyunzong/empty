# quotalib

限额库：主体经别名图解析，合并原子化，分裂受租约保护，事件可重放并核对全局额度守恒。仅使用 Go 标准库。

## 设计

- **别名图解析主体**：`Store` 内部为并查集（按秩合并 + 路径压缩）。`AddAlias(alias, target)` 连接两个名字；`Resolve` 沿别名链找到当前根。
- **环报告**：若两个名字已属于同一主体，别名请求被拒绝并记入 `Cycles()`，图保持不变。
- **原子合并**：所有变更共用一把互斥锁。合并时新根继承双方限额、已用余额与全部活租约；此后发往旧别名的请求沿新根计费（`Consume`/`AcquireLease` 先 `Resolve` 再入账）。
- **分裂保护**：`Split(a, b)` 仅在主体无活租约时允许（`ErrActiveLeases`）。每个名字持有独立的 limit/used 份额账本，分裂时移除别名边、按剩余边重建连通分量，份额随名字走，额度精确还原。
- **事件重放与守恒**：`Replay` 按序应用 `set_limit`/`rename`/`consume`/`acquire_lease`/`release_lease`/`split` 事件，失败事件跳过并汇总为 `ReplayError`。`VerifyConservation` 核对全局守恒：所有根的限额总和 == 累计授予额，已用总和 == 累计消费额。

## 测试结果

`go test ./... -count=1` 实际输出（2026-10-05，go1.27.1 linux/amd64）：

```
ok  	quotalib	0.017s
```

`go test ./... -v -race -count=1`：9 个测试全部 PASS（含并发合并+消费的竞态检测），详见提交时的会话记录。
