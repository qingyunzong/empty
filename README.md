# traj — 轨迹分段库

纯 Go 标准库实现，无第三方依赖。

## 连段规则

- 点按 `(T, ID)` 排序，仅相邻点之间可能连边。
- 相邻点 `a -> b` 连边当且仅当 `0 <= b.T - a.T <= g` 且
  `dx*dx + dy*dy <= r*r`（坐标为整数，全程比较距离平方，不做浮点开根）。
- 段是极大的连续连通 run；`Upsert` 更正点的坐标/时间可能使段拆分或合并，
  实现只对受影响邻域做局部重分段。

## 输出稳定性

- `Segments()` 按 `MinID`（段内最小成员 ID）排序，段即以此 ID 标识。
- 段内 `Edges` 按时间序给出（`A` 先于 `B`）。
- 输出只取决于当前点集，与更新历史无关：任意随机更新序列的结果
  与全量排序重建完全一致（由 `TestRandomUpdatesMatchRebuild` 对照验证）。

## API

```go
ix := traj.New(g, r)          // g: 最大时间差; r: 最大距离(内部存 r^2)
ix.Upsert(traj.Point{ID: 1, T: 0, X: 0, Y: 0}) // 新增或更正
ix.Remove(1)                  // 删除
segs := ix.Segments()         // []Segment{MinID, Size, Edges}
```

坐标与时间戳需在 ±2^31 内，保证距离平方不溢出 int64。

## 测试结果（实际运行记录)

环境：go1.27.1 linux/amd64，命令 `go vet ./... && go test ./... -count=1 -v`
（沙箱中需设 `GOCACHE=/tmp/gocache`，默认缓存目录只读）。

```
=== RUN   TestTimeGapBoundary               --- PASS (0.00s)
=== RUN   TestDistanceBoundaryIntegerOnly   --- PASS (0.00s)
=== RUN   TestEqualTimestampsLink           --- PASS (0.00s)
=== RUN   TestCorrectionSplitsAndMerges     --- PASS (0.00s)
=== RUN   TestCorrectionMergesTwoSegments   --- PASS (0.00s)
=== RUN   TestRemoveSplitsOrKeepsSegment    --- PASS (0.00s)
=== RUN   TestOutOfOrderInsertion           --- PASS (0.00s)
=== RUN   TestEmptyAndSingleton             --- PASS (0.00s)
=== RUN   TestRandomUpdatesMatchRebuild     --- PASS (10.38s)
        5 个种子 × 3000 次随机 增/改/删，每次操作后与排序重建对照
PASS
ok      traj    10.392s
```
