# planner

预约规划库（仅 Go 标准库）。在至多 16 个请求中选取收益最大的可行子集，
为每个阶段分配指定类型房间与指定设备，占用区间前后附带消毒间隔。

## 功能

- `Solve(*Problem) (*Plan, error)`：枚举请求子集（2^16 以内）并回溯分配
  窗口与房间，最大化总收益；收益相同时最小化相对 `OldPlan` 的改动
  （旧请求被取消或移动的次数，新增请求不计改动）。
- 两阶段请求：阶段间隔必须落在 `[MinGap, MaxGap]`；一个请求要么全部
  阶段都被排入，要么整单取消，不存在部分履约。
- `Existing` 中已确认订单作为固定占用参与冲突检查，不会被移动。
- `Certificate`：输出每个资源（房间/设备）的时轴（含消毒区间）以及
  两阶段请求的间隔证书。
- `Verify`：独立校验计划——阶段完整性、候选窗口、房型与设备匹配、
  资源冲突（含消毒间隔与已有订单）、阶段间隔上下限、收益一致性。

## 测试

`planner_test.go` 中的 `bruteForce` 是与求解器相互独立的全状态穷举，
`TestExhaustiveSmallState` 用 500 个随机小实例（1–6 请求、1–2 阶段、
随机缓冲/间隔/旧计划/已有订单）核对收益与改动数均一致；
`TestSixteenRequests` 在 16 请求上限规模下做同样核对。

实际运行结果（go1.27.1 linux/amd64, `go test ./... -v`）：

```
=== RUN   TestExhaustiveSmallState
--- PASS: TestExhaustiveSmallState (0.05s)
=== RUN   TestTwoStageGapAndCancelSemantics
--- PASS: TestTwoStageGapAndCancelSemantics (0.00s)
=== RUN   TestExistingBookingsImmovable
--- PASS: TestExistingBookingsImmovable (0.00s)
=== RUN   TestTieBreakMinChanges
--- PASS: TestTieBreakMinChanges (0.00s)
=== RUN   TestCertificateAndTimeline
--- PASS: TestCertificateAndTimeline (0.00s)
=== RUN   TestTooManyRequests
--- PASS: TestTooManyRequests (0.00s)
=== RUN   TestSixteenRequests
--- PASS: TestSixteenRequests (0.03s)
PASS
ok  	planner	0.081s
```
