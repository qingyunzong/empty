# petri — 有界 Petri 网可达性模拟库

仅使用 Go 标准库。网至多 8 库所（`MaxPlaces`）、每库所容量 4（`Capacity`），
转换由消耗/产生表描述，支持守卫（`Guard`）、优先级（`Priority`）与复位弧（`Reset`）。

## 语义

- **点火条件**：各库所 token 不少于消耗表，且守卫成立；产生后任何库所超过容量 4 则该转换不可发。
- **统一消费后复位**：点火时先做统一消费，再执行复位弧（清零对应库所），最后加入产生 token。
- **优先级**：仅当没有更高优先级的转换就绪时，低优先级转换才可发。
- **重复状态去重**：所有搜索均以 `Marking`（可比较数组）为键去重。

## 功能

- `Net.Search(initial, target)`：BFS 最短轨迹；可达返回 `Certificate{Path, States}`，
  不可达返回完整闭包 `Certificate{Closure}`。
- `Net.Closure(initial)`：完整可达闭包。
- `Net.NaiveClosure` / `Net.NaiveShortestDistance`：朴素 BFS 对照实现（线性扫描去重、独立推导语义）。
- `Net.Enumerate(initial)`：第三份独立状态枚举器，用于交叉核对。
- `Net.FairCycle(initial)`：寻找公平无限运行，返回 lasso 证书（前缀 + 环）。
  环上每个转换要么在环中点火，要么在环的某个状态不可发（满足公平性）；
  构造基于可达图的 SCC，环会遍历分量中所有可点火的转换。
- `Net.IsFairCycle`：校验环证书的公平性。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，命令 `go test ./...`（GOCACHE=/tmp/gocache）：

```
ok  	petri	0.014s
```

`go test -v` 全部 11 个测试通过：

- TestShortestTrajectory — 最短轨迹证书长度与朴素 BFS 距离一致
- TestCapacityOverflowBlocksFiring — 容量溢出转换不可发；不可达时返回完整闭包 {0,2,4}
- TestDeduplication — 菱形交织去重后闭包大小为 4
- TestPriority — 高优先级就绪时低优先级不可发；高优先级禁用后低优先级可发
- TestResetArc — 统一消费后复位再产生；复位库所可重新填充不溢出
- TestGuard — 守卫在容量之内提前阻断点火
- TestCrossCheckImplementations — 三组手工网上三种实现闭包一致
- TestRandomCrossCheck — 30 个确定性伪随机网（含守卫/优先级/复位弧）上：
  三种枚举闭包一致，且每个可达状态的 BFS 最短距离与朴素 BFS 一致
- TestFairCycleSimple / TestFairCycleWithDetour / TestFairCycleNone —
  公平环证书可重放、环闭合、公平性成立；无环网正确返回未找到
