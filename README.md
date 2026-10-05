# docset

文档 token 集合检索库（仅 Go 标准库）。

- 每篇文档是一个 token 集合，重复 token 只计一次。
- `Query` 按 Jaccard 相似度（空-空定义为 1）与有理数阈值比较，
  命中按分数降序、再按 ID 升序返回。
- 阈值查询带候选剪枝证书：每个未扫描文档附带可由 `Len` 复算的
  相似度上界 `min(|Q|,|D|)/max(|Q|,|D|)`；预算不足时返回确定命中
  （`Hits`）、已精确排除（`Rejected`）与未闭合候选（`Unclosed`）。
- `CorrectTokens` 分支 token 更正原子更新倒排索引与长度索引：
  先校验后应用，失败调用不改变任何索引。
- 测试含随机增删/更正后与逐文档集合交并模型的核对，以及独立
  全比较核对（不漏命中、上下界有效、预算遵守、排序正确）。

## 测试结果（实际运行）

```
$ go test ./...
ok  	docset	0.013s
```

7 个测试全部通过：`TestEmptyEmptySimilarityOne`、`TestHitOrdering`、
`TestBudgetReturnsUnclosed`、`TestFullComparisonSweep`、
`TestInsertDeleteErrors`、`TestCorrectTokensAtomic`、
`TestRandomizedModelCrossCheck`。
