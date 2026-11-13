# 实体解析传递边约束

客户数据管线可直接使用本包完成实体聚类。输入 must-link、cannot-link 和带
分数的候选边；输出确定性簇、每条候选边的处理结果，以及被拒边的最小冲突路径。

## 使用

```go
result, err := dataeng.Cluster(
    []dataeng.Pair{{Left: "a", Right: "b"}},
    []dataeng.Pair{{Left: "b", Right: "c"}},
    []dataeng.Candidate{
        {Left: "a", Right: "c", Score: 0.9},
        {Left: "c", Right: "d", Score: 0.8},
    },
)
```

也可以先调用 `dataeng.New` 构建可复用的硬约束图，再多次调用
`Graph.Cluster`。`Graph` 的硬约束不可变，每次聚类都在私有副本上进行。

## 语义

- 候选边按 `Candidate.Less` 处理：分数降序；同分时按公开的
  `Candidate.TieKey()` 升序；完全相同的键保持输入顺序（稳定排序）。
- must-link 先全部合并。cannot-link 会随合并向新簇传播，因此若 `a` 与 `b`
  不可同簇，而 `a` 后续与 `c` 合并，则 `b` 与 `c` 的合并也会被拒绝。
- 被拒边可通过 `Result.Rejected[i].Path` 取得最小冲突路径。路径中恰有一条
  cannot-link，其余为 must-link 或已接受候选边；边数最少的路径优先。
- 硬约束自相矛盾时，`New`/`Cluster` 返回可用 `errors.Is(err,
  dataeng.ErrInconsistent)` 判断的错误。

## 小图核对

`Graph.EnumeratePartitions` 枚举满足硬约束的全部集合划分（最多
`MaxEnumerationEntities` 个实体），可用作贪心结果的独立核对基准。测试中
对随机小图逐条验证：接受边当且仅当存在一个硬约束可行的划分，既保留此前
所有簇又让该边两个端点同簇。仅出现在候选边中的实体可先用
`Graph.Register` 纳入枚举范围。
