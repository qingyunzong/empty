# msgbuf — 带字节预算的因果消息库

纯 Go 标准库实现（无任何第三方依赖）的因果有序消息缓冲库。

## 语义

- **按载荷字节计账**：每条消息在缓冲区占用恰好 `len(Payload)` 字节（`Message.Size()`）。
- **因果阻塞项占额度**：依赖未满足而被阻塞（`Blocked`）的消息驻留缓冲区，计入 `Used()`。
- **超额拒绝且不推进接收向量**：缓冲一条消息会超过预算时，`Receive` 返回
  `*BudgetError`，缓冲区状态（含接收向量）完全不变。
- **交付后释放**：消息一旦交付（含级联交付），其字节立即从 `Used()` 中释放。
- **缺依赖报告完整链**：阻塞或被拒绝时，`Report.Missing` / `BudgetError.Missing`
  给出完整的传递闭包缺失链——直接缺失依赖，加上其中已缓冲项的缺失依赖，递归到底。
- 重复消息（已交付或已缓冲）是无操作（`Duplicate`），不占预算、不改状态。
- 预算为负数表示无限额度。

## API 摘要

```go
b := msgbuf.New(budgetBytes)
rep, err := b.Receive(msg)   // err 为 *BudgetError 时表示超额拒绝
rep.Outcome                  // Delivered / Duplicate / Blocked
rep.Missing                  // 完整缺失依赖链（Blocked 或被拒绝时）
rep.Now                      // 本次调用交付的消息（含级联），按交付序
b.Used()                     // 当前阻塞消息占用的载荷字节数
b.Vector()                   // 接收向量副本
```

## 测试

- `msgbuf/buffer_test.go`：单元测试，覆盖立即交付、阻塞占额与级联释放、
  超额拒绝保持状态、传递缺失链、重复无操作、自身序号缺口、无限额度、精确预算边界。
- `msgbuf/random_test.go`：随机化模型核对。随机生成 4 发送者 × 25 条因果一致消息，
  随机顺序收发（含重复重收、拒绝后随机重排重试），每一步与无预算的全量因果模型核对：
  预算守恒（`Used()` == 模型中已接收未交付消息的载荷字节和）、不超预算、
  接收向量一致、缺失链完整、交付日志是合法因果线性化；结束时全部交付且 `Used() == 0`。

## 实际测试结果（2026-10-05，go1.27.1 linux/amd64）

```
$ go test ./... -count=1
ok  	msgbuf/msgbuf	2.264s

$ go test ./... -count=1 -race
ok  	msgbuf/msgbuf	8.742s
```

详细：21 个测试全部 PASS（8 个单元测试 + TestRandomBudgetConservation 的
12 个子测试：预算 64 / 512 / 无限 × 种子 1–4）。紧预算（64 字节）下
100 条消息经 2573–3960 步（含拒绝重试）全部交付，预算守恒逐步成立。
