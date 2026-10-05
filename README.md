# perm — 权限区间库

将授予（Grant）、撤销（Revoke）与临时例外（Exception）事件流转换为
动作有效的半开区间时间线，仅使用 Go 标准库。

## 语义

- **同 tick 按版本序**：同一 tick 的事件按 `Version` 升序应用。
- **撤销优先**：同 `(tick, version)` 下 Revoke 在 Grant 之后应用；
  重叠的例外窗口中 deny 例外覆盖 allow 例外。
- **临时例外**：窗口为半开区间 `[Tick, End)`，携带覆盖动作。
- **历史更正**：事件的 `Corrects` 字段取代被引用的历史事件，可链式更正。
- **区间**：有效动作表示为半开区间 `[Start, End)`；当动作与完整授权链
  均相同且相邻时合并（`End == math.MaxInt64` 表示无界）。
- **查询**：`Query(tick)` 返回完整授权链
  （default → 历次 grant/revoke → allow 例外 → deny 例外）。

## 验证

区间时间线与逐 tick 状态模型（`decide`）在每个 tick 上核对一致，
并检查半开、连续、边界精确与相邻合并最大化等不变量；
包含确定性场景、历史更正（含链式更正）与 200 组随机化对照。

## 实际测试结果

```
$ go test ./... -count=1 -v
=== RUN   TestDeterministicTimeline
--- PASS: TestDeterministicTimeline (0.00s)
=== RUN   TestCorrections
--- PASS: TestCorrections (0.00s)
=== RUN   TestRandomizedAgainstStateModel
--- PASS: TestRandomizedAgainstStateModel (0.08s)
PASS
ok  	perm	0.105s
```

（2026-10-06 实测，go1.27.1 linux/amd64，仅标准库。）
