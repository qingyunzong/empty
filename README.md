# 会话窗动态合并与撤回

流聚合层需要可导入的 Go session window 状态库，事件到达可桥接多个窗口，迟到事件又可能撤回已发结果。合并后只保留一个规范窗口 id；更新流给出成对 retract/add。水印封闭和允许迟到结束后回收状态，重放得到同一变更序列。

## 用法

库代码在 `session/` 包（`example.org/dataeng/q0250/session`），泛型于分组键 `K`、事件值 `V` 与累加器 `A`：

```go
type sumAgg struct{}

func (sumAgg) New() int           { return 0 }
func (sumAgg) Add(acc, v int) int { return acc + v }
func (sumAgg) Merge(a, b int) int { return a + b }

s := session.New[string](10, 5, sumAgg{}) // gap=10, allowedLateness=5

changes, dropped := s.OnEvent("user", ts, 1) // 每次事件返回变更序列
reclaimed := s.OnWatermark(wm)               // 回收已封闭窗口的状态
```

语义要点：

- 事件落在候选窗 `[ts, ts+gap)`，与所有相交存活窗口合并；合并后只保留最小 id 作为规范窗口 id，被合并窗口从更新流撤回。
- 更新流为成对 `Retract`/`Add`：对已发结果的任何修订都先撤回旧值再发布新值，`Change.Seq` 全库单调递增。
- 水位线超过 `End + allowedLateness` 时回收窗口状态（最后一次 `Add` 即为最终结果）；此后比水位线迟到超过允许时长、且不属于任何存活窗口的事件被丢弃。
- 窗口 id 由单调计数器分配、合并折叠顺序确定，向新实例重放同一输入序列会得到完全相同的变更序列。

运行测试：`go test ./...`
