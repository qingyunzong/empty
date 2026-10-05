# statcorr

按共同有效时间点对齐的两列精确 Pearson 相关统计库。仅使用 Go 标准库
(`math/big`)。每个序列至多 20 个点。

## 匹配(match.go)

两个点序列(有理时间戳 `*big.Rat`、整数值 `*big.Int`、字符串 ID)按有理
最大间隔 `maxGap` 做一对一匹配,依次优化:

1. 匹配对数最大;
2. 总时间差 `Σ|tA−tB|` 最小;
3. 同差按 ID:取排序后 `(A.ID, B.ID)` 对列表字典序最小的最优匹配。

实现:时间排序序列上的 DP 给出最优对数与总差(交叉匹配总能不增成本地
解交叉);随后按 `(A.ID, B.ID)` 顺序贪心构造字典序最小的最优匹配——每个
候选对保留当且仅当仍存在包含它的最优解(用同一 DP 作预言机)。不做"相同
时间点直接相连"的简化:`TestMatchNoEqualTimeSimplification` 验证等时连接
之外的最优对仍被匹配。

## 统计(stats.go)

`Stats` 以精确整数增量维护 `n, Sx, Sy, Sxx, Syy, Sxy`,支持 `Add`/`Remove`
对齐点;`Direct` 为直接求和参照模型。输出精确整数:

- `CovNum = n·Sxy − Sx·Sy`(= n²·协方差)
- `VarXNum = n·Sxx − Sx²`,`VarYNum = n·Syy − Sy²`

相关系数保留根式:`r = Num·√Rad/Den`,`Rad` 无平方因子。少于两个对齐点
或任一序列零方差时返回无定义(`undefined(<reason>)`)。

## 引擎(engine.go)

`Engine` 持有两个序列;任何增删后 `Evaluate` 重新匹配并基于新匹配重建统
计(匹配变化即重算相关)。`Certificate` 输出匹配证书(对数、总差、逐对
时间差)与统计证书(各阶和、协方差/方差整数、相关系数)。

## 核对测试

- `TestMatchAgainstBruteForce`:1000 组随机序列(≤7 点/侧、有理时间、随
  机间隔),与独立全枚举匹配逐一比对对数、总差与逐对 ID。
- `TestIncrementalAddRemoveVsDirect`:500 步随机增删,每步与直接求和模型
  比对完整统计证书。
- 其余:间隔边界、同差 ID 次序、根式化简(`sqrt(3)/2`、`5*sqrt(33)/33`)、
  无定义情形、匹配变化触发重算、20 点上限。

## 实际测试结果

`go test ./... -count=1`(go1.27.1 linux/amd64,GOCACHE=/tmp/gocache):

```
ok  	statcorr	1.523s
```

15 个测试全部 PASS,包括 `TestMatchAgainstBruteForce (0.43s)` 与
`TestIncrementalAddRemoveVsDirect (0.91s)`;`go vet ./...` 与 `gofmt -l .`
无输出。
