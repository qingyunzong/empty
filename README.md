# 租约库（formal）

面向“打开—修改—回写”场景的 Go 租约库，保证同一对象的写许可在任意时刻
至多被一方持有，并覆盖续约、中断、脏数据回写与租约窃取。

## 核心机制

- 每个租约带单调递增的栅栏令牌 `Lease.Epoch`，每次所有权转移（`Acquire`/
  `Steal`）都令其加一。
- `FencingStore` 只接受比已接受 epoch 严格更大的回写；旧持有者即使迟到地
  回写也会得到 `ErrStaleToken`，无法覆盖新持有者的数据，也无法重复落盘。
- `Break`（中断）严格按“先回写脏数据，再释放租约”执行；`Steal`（窃取）
  先以受害者 epoch 回写其脏数据，再以更高 epoch 移交所有权。
- 旧租约回执（已被更高 epoch 取代）在 `Renew`/`Flush`/`Break`/`MarkDirty`
  上一律返回 `ErrStaleToken`，不能阻止或干扰新持有者。

## API

- `NewManager(sink, ...Option)`：创建管理器，可注入时钟与 TTL。
- `Acquire(object, holder)`、`Renew(token)`：获取/续约。
- `MarkDirty(token, data)`、`Flush(token)`：记录与回写脏数据。
- `Break(token)`：回写后释放。
- `Steal(object, thief)`：强制接管（含脏数据回写与 epoch 提升）。

## 验证方式

每个操作都被拆成有序、幂等的微步骤。生产代码在单把互斥锁内原子执行这些
步骤；测试则在不加锁的情况下枚举所有步骤交错序列：

- 每个微边界都与一份独立手写的“朴素租约表”（`naive_test.go`）逐字段对照
  持有者、epoch、脏标记、缓冲数据和存储快照。
- 断言任意时刻至多一个持有者；续约与窃取交错时只有一个结果生效。
- 断言脏租约的 `Flush`/`Break`/`Steal` 任意交错下，存储接受的回写次数恒为
  1（不双写），且数据内容不被旧回执破坏。
- `TestScheduleCount` 校验穷举规模（例如 4 步续约 × 4 步窃取 = C(8,4)=70 个
  序列）；`TestConcurrentStress` 在 `-race` 下进行真实并发压测。

运行：

```
go test ./...
go test -race ./...
```
