# sigdb — 分段线性信号监测库

按时间戳维护分段线性信号，范围积分使用精确有理数（`math/big.Rat`），
提供可持久化的增量积分索引。仅使用 Go 标准库。

## 语义

- **样本与版本**：每个时间戳最多一条生效记录（存在值 / 缺失标记 / 墓碑）。
  同一批或跨批的重复时间按版本高者覆盖，版本不高者（含相等）被丢弃。
- **缺失切断区间**：缺失标记与墓碑都切断信号，只有相邻两条"存在"样本
  之间才线性插值，绝不跨洞插值。
- **精确积分**：每段积分为梯形精确有理数；范围查询在段边界处裁剪后求和。
- **批更正一次发布**：`Store.Apply` 将整批操作折叠为一个新代（generation），
  原子发布；此前返回的 `Snapshot` 对旧读者永久有效（不可变路径复制）。
- **局部区间逆差**：更正只影响变更时间戳邻域的段，`Apply` 返回
  `Delta{Removed, Added}`，索引按"删旧段、插新段"做 O(log n) 路径复制更新。

## 持久化与断电一致性

- 追加式页面文件（`data.db`）：索引节点页与样本快照页只追加、不覆盖，
  旧代的页保持有效，旧读者不受新提交影响。
- 提交记录（`commit.db`）：双槽、带 CRC32 校验，单条记录同时发布
  样本快照页与索引根页——因此断电不可能出现"新积分配旧样本版本"的混合态。
- 提交顺序：写全部新页 → fsync(data) → 写提交记录 → fsync(commit)。
  恢复时取校验通过的最高代，并截断数据文件的撕裂尾部。
- 崩溃枚举测试对一次提交的每个副作用操作（索引页写、数据 fsync、
  根发布写、根 fsync）以及撕裂写变体逐一注入断电，验证恢复后必然落在
  提交前或提交后某一个完整一致代上，且积分与样本版本互相一致。

## 实测结果

```
$ go test -race -count=1 -v ./...
=== RUN   TestCrashEnumeration
    crash_test.go:262: commit of batch2 executes 8 side-effecting ops
--- PASS: TestCrashEnumeration (0.03s)
=== RUN   TestRootPublishFailure
    crash_test.go:351: root publish executes 2 commit-file ops
--- PASS: TestRootPublishFailure (0.01s)
=== RUN   TestRecoveredIndexMatchesSamples
--- PASS: TestRecoveredIndexMatchesSamples (0.05s)
=== RUN   TestBasicIntegral
--- PASS: TestBasicIntegral (0.00s)
=== RUN   TestMissingCutsSignal
--- PASS: TestMissingCutsSignal (0.00s)
=== RUN   TestVersionOverwrite
--- PASS: TestVersionOverwrite (0.00s)
=== RUN   TestLocalInverseDelta
--- PASS: TestLocalInverseDelta (0.00s)
=== RUN   TestRandomizedDifferential
--- PASS: TestRandomizedDifferential (0.16s)
=== RUN   TestPersistenceReopen
--- PASS: TestPersistenceReopen (0.02s)
PASS
ok  	sigdb	1.289s
```

`go test ./...`（Go 1.27.1, linux/amd64）：**ok sigdb**，9/9 通过；
另以 `-count=3` 复跑通过，`gofmt -l .` 无输出。

## 文件

- `entry.go` — 操作、版本裁决、段推导、精确段积分、局部逆差 diff
- `treap.go` — 不可变 treap 增量积分索引（子树有理数和 + 时间跨度剪枝）
- `pager.go` — 追加式页面文件、双槽原子提交记录、恢复
- `store.go` — `Store` / `Snapshot` / `Apply` / `Integral` API
- `store_test.go` — 逐段积分模型对照、版本语义、缺失切断、快照保留、重开
- `crash_test.go` — 断电故障注入设备、提交全程故障枚举、根发布故障、恢复一致性
