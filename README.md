# idalloc

持久化整数编号库（仅 Go 标准库）。核心保证：**任何故障下不重复发号，允许空洞**。

## 设计

- `Allocator`（`allocator.go`）：集中分配互不重叠的整数区间 `[Start, End]`。
  高水位 `Next` 单调递增，且**先落盘（Write+Sync）后确认**；确认丢失只会
  让区间闲置（空洞），绝不重发。同一 Storage 同一时刻只允许一个 Allocator 实例。
- `Node`（`node.go`）：从租约（Lease）发号。游标**先持久化、再发号、落盘后
  二次校验代际**——崩溃或代际被关闭时宁可烧号（空洞）也不重发。重启后 `Load`
  从持久游标续用未消费尾部。
- 区间转让（`Transfer` / `HandOver`）：**先持久化关闭旧代**，再读取旧主持久
  游标，最后以新代际重新发行未消费尾部。旧代持有者被 `Validate` fencing。
- `Storage`（`storage.go`）：`FileStorage`（临时文件 + fsync + rename + 目录
  fsync）与 `CrashStorage`（故障注入：写失败、崩溃丢失未同步数据、代际失效）。
  确认丢失在测试侧以"发号结果随机丢弃"注入。

## 测试

- `idalloc_test.go`：重启续用尾部、转让关闭旧代并 fencing、崩溃后游标不丢、
  落盘失败不消耗号码、并发发号唯一。
- `chaos_test.go`：多种子混沌测试，随机注入写失败 / 操作中途崩溃 / 确认丢失，
  核对**全历史发号唯一**、区间表不重叠；附"先确认后落盘必重号"的反面控制组。

运行：`go test ./...`（实际结果见 `TEST_RESULTS.md`）。
