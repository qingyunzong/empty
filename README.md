# workgroup

任务组库：组内任务可等待其他组，组间等待边必须构成 DAG。

## 设计

- `Environment` 持有全部组与等待边（`a -> b` 表示 a 等待 b）。
- `Group.Go` 在同一把互斥锁内检查冻结标志并登记成员：任务要么在冻结前被
  计数，要么在冻结后被拒绝，创建与关闭交错不会漏记成员。
- `Group.Shutdown` 先冻结成员登记，再用 `sync.Cond` 等待已登记成员全部退出。
- `Group.DependsOn` 加边前做 DFS 可达性检查；若新边会成环，返回
  `*CycleError`，`Path` 为完整环证据（新边 + 已有路径，首尾同节点）。
- `Group.WaitOn` = `DependsOn` + 阻塞至对方组排空。
- `checker` 包是独立图检查器：用 Kahn 拓扑排序判定合法性（与库内 DFS
  不共享代码），再用三色 DFS 提取见证环；测试用它交叉核对每条被接受/
  被拒绝的边。

## 测试结果（2026-10-05, go1.27.1 linux/amd64）

```
$ go test ./...
ok  	workgroup	0.114s
ok  	workgroup/checker	0.006s

$ go test -race -count=2 ./...
ok  	workgroup	1.330s
ok  	workgroup/checker	1.030s
```
