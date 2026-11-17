# formal — 训练平台集群配额规划库

供集群调度器调用的 Go 配额规划库：在多团队共享的训练集群上，决定每一轮
调度中哪些任务运行、哪些被抢占。支持层级保底、闲置借用、gang 任务与
可抢占优先级，并附带小集群穷举验证器。

## 快速开始

```go
tree := &formal.Tree{Root: &formal.Node{
    Name: "root", Guarantee: 8,
    Children: []*formal.Node{
        {Name: "nlp", Guarantee: 4},
        {Name: "cv", Guarantee: 4},
    },
}}
plan, err := formal.Plan(formal.Input{
    Capacity: 8,
    Tree:     tree,
    Jobs:     jobs, // 运行中 + 排队中的 gang 任务
}, nil)
// plan.Start     — 本轮应启动的任务
// plan.Preempt   — 本轮应抢占的任务
// plan.Allocated — 目标运行集合（稳定公平序）
// plan.Score     — 目标函数值
```

`Plan` 是纯函数：同一输入必得同一输出，树与输入不可变，可并发调用。

## 语义模型

规划器把调度策略编码为一个字典序目标函数（`Score`），逐级最大化：

1. **层级保底 `Protected`**：每个非根节点按规范顺序（优先级降序、到达
   顺序、ID）取其子树任务的保底前缀——累计资源不超过该节点
   `Guarantee` 的最长前缀。第 0 层是任务所在队列自身的保底，第 1 层是
   父节点，依此类推。先满足队列保底，再满足更靠近子树的祖先保底，
   因此**闲置借用**优先发生在兄弟子树内部，回收时也先跨分支回收。
2. **可抢占优先级 `Tier`**：按优先级从高到低逐层最大化已分配资源。
   高优先级任务因此可以抢占低优先级任务（包括有已完成工作的任务）。
3. **已完成工作保留 `KeptWork`**：在前两层目标相同的前提下，最大化
   继续运行的任务的已完成工作总量——回收借用资源时自动选择
   **已完成工作损失最小**的牺牲者集合。
4. **稳定公平**：剩余平局按规范顺序确定性打破，最优分配唯一。

约束：

- **gang 原子性**：每个任务（`Members × UnitsPerMember`）要么整体分配，
  要么整体不分配，绝不拆分。
- **不可抢占**：`Running && !Preemptible` 的任务永远保留；若其总量超过
  集群容量，返回 `ErrOverCapacity`。
- 树不变量：兄弟节点保底之和不超过父节点保底，根保底不超过集群容量
  （`Tree.Validate` 校验）。

## 求解器

- 默认**精确动态规划**：把上述目标展开为逐任务可加的分值向量，做
  0/1 背包 DP，复杂度 O(任务数 × 容量 × 分值维数)，结果与穷举最优
  严格一致。
- 超出 `Options.MaxExactCells`（默认约 2M 单元）时回退到**确定性贪心**：
  先放置所有队列保底内的任务（由树不变量保证必然放得下），再按规范
  顺序填充。贪心保持全部保底与可行性不变量，但装箱可能次优。

## 穷举验证

`BruteForce` 枚举小集群（默认不超过 24 个任务）的全部可行分配并返回
最优者；`Verify` 用独立枚举复核一个分配方案的可行性（容量、gang 原子
性、不可抢占保留）与最优性。由于平局打破是全序，最优分配唯一，精确
规划器必须逐任务复现穷举结果。

```go
if err := formal.Verify(input, plan); err != nil { /* 方案不可行或次优 */ }
```

测试覆盖：

- `TestPlanMatchesBruteForce`：400 个随机小集群上规划器与穷举逐任务一致；
  `QUOTA_STRESS_SEEDS=30000 go test -run TestStress ./...` 可扩大对照规模。
- `TestPlanInvariants` / `TestGreedyFallbackInvariants`：较大随机实例上的
  容量、保底、不可抢占与确定性不变量。
- `TestFairSharesGuaranteeHonored`：层级水填法公平份额（`FairShares`，
  供监控展示）始终满足 min(需求, 保底)。

## API 一览

| 符号 | 说明 |
| --- | --- |
| `Plan(Input, *Options) (*Result, error)` | 计算一轮目标分配 |
| `BruteForce(Input) (*Result, error)` | 小集群穷举最优（独立验证器） |
| `Verify(Input, *Result) error` | 复核方案的可行性与最优性 |
| `FairShares(*Tree, float64, map[string]float64)` | 层级公平份额（监控用） |
| `Tree.Validate(int64) error` | 校验配额树不变量 |
