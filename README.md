# workgroup

任务工作组库（仅使用 Go 标准库）。

## 功能

- **组成员生命周期**：`Group.Add`/`Done`/`Go` 登记与退出成员；
  `Close` 先冻结成员（之后的 `Add` 返回 `ErrFrozen`），再等待已准入成员全部退出。
  `Add` 与 `Close` 共用同一把互斥锁，创建与关闭交错时不会漏记成员：
  每个成功的 `Add` 必然被 `Close` 观察到并等待其 `Done`。
- **组间等待**：`Graph.AddWait(from, to)` 记录 from 等待 to 的边；
  `Group.WaitOn(other)` 声明等待并阻塞到对方完全关闭。
- **禁止等待环**：加边前用 BFS 检查 to 是否已可达 from；若成环则拒绝加边，
  返回 `*CycleError`，其 `Path` 为包含被拒不边的完整环证据（首尾同组）。
- **独立图检查器**：`Checker` 与 `Graph` 不共享任何状态与算法，
  基于 Kahn 拓扑排序独立判定边集是否无环（`Acyclic`）并提取环（`Cycle`），
  用于核对库接受的每条等待边都合法、拒绝的边确实成环。

## 测试结果

`go test ./...`（go1.27.1 linux/amd64）实际输出：

```
ok  	workgroup	0.161s
```

另以 `go test -race -count=5 ./...` 复跑通过（ok workgroup 1.920s）。
