# 数据合并的相似记录全局匹配

去重服务调用可导入的Go记录配对包，左右记录各至多18条，同侧ID唯一，重复候选边拒绝；候选边由调用方给定非负整数代价；每条记录至多匹配一次，先使匹配数最多，再使总代价最小，最后按左ID升序的右ID列表决胜，未匹配用大于所有ID的哨兵。输出匹配及未匹配项，禁止逐行贪心导致全局次优。ID按UTF-8字节比较，总代价任意精度。测试稀疏候选、零代价及多最优方案，以小规模全部配对作参考。

## 使用

```go
result, err := dataeng.Match(
    []string{"L0", "L1"},
    []string{"R0", "R1"},
    []dataeng.Candidate{
        {LeftID: "L0", RightID: "R0", Cost: 1},
        {LeftID: "L0", RightID: "R1", Cost: 2},
        {LeftID: "L1", RightID: "R0", Cost: 0},
    },
)
```

`Result` 包含：

- `Matches`：按左ID字节序排列的匹配对及其边代价。
- `UnmatchedLeft`、`UnmatchedRight`：两侧未匹配记录。
- `RightForLeft`：按左ID升序排列的右ID；未匹配项为 `dataeng.Sentinel`。
- `TotalCost`：任意精度的总代价，也可用 `TotalCostString()` 获取十进制文本。

`Candidate.Cost` 支持 `*big.Int`、`big.Int`、十进制字符串、`json.Number`
以及所有有符号/无符号整数类型，因此总代价不受 64 位限制。

## 算法与约束

- 用右记录位掩码做动态规划，状态记录“已占用右记录集合”的最低总代价，
  并对同代价状态保存字典序最小的左记录分配，得到全局最优解。
- 目标按三层优先级比较：匹配数最大、总代价最小、按左ID升序的右ID列表
  （未匹配视为高于所有ID的哨兵）字典序最小。
- 时间复杂度上界为 `O((L + E) * 2^R)`，其中 `L, R <= 18`、`E` 为候选边数；
  额外空间为 `O(2^R)`。
- 超过 18 条记录、同侧重复 ID、重复候选边、未知 ID、负数或非整数代价
  均返回可被 `errors.Is` 识别的错误。
