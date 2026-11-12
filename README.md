# 倒排分块上的精确块上界检索

`example.org/dataeng/q0302` 提供可导入的 Go 索引构建与查询包。所有分数使用
`math/big.Rat` 精确计算，不使用浮点，也不使用任意规则打破同分。

## 构建

```go
store := dataeng.NewMemoryStore() // 也可以是宿主自己的只写存储实现
metadata, err := dataeng.BuildIndex(
    []uint64{4, 2, 1, 3}, // 目录会排序为 1,2,3,4；重复 ID 会被拒绝
    map[string][]dataeng.Posting{
        "go": {
            {DocumentID: 1, Contribution: big.NewRat(3, 2)},
            {DocumentID: 2, Contribution: big.NewRat(1, 2)},
        },
    },
    2, // 每个词项独立按 2 条 posting 分块
    store,
)
```

`BuildIndex` 会校验目录、目录外 ID、posting 严格递增、贡献非负且非 nil。
每块的 `MaxContribution` 都由块内 posting 实际计算。写入时传给
`BlockWriter.WriteBlock` 的是该块完整 posting 的深拷贝。

## 查询

```go
searcher, err := dataeng.NewSearcher(metadata, store)
result, err := searcher.Search(
    map[string]*big.Rat{
        "go":      big.NewRat(2, 3),
        "unknown": big.NewRat(1, 1), // 未知词项按空 posting 表处理
    },
    map[uint64]struct{}{1: {}}, // 排除文档
    2,                          // k=0 返回空
)
```

`Searcher` 只持有目录、块元数据和 `BlockReader`。查询按文档 ID 升序维护每个
词项的当前块；窗口终点取所有词项当前块结束/下一块开始边界的最小值，因此窗口
内每个词项的贡献上界恒定。窗口上界为各词项 `权重 × 块最大贡献` 的精确和，
不会用一个块上界跨过其他词项更早的块边界。

只有已形成 k 个候选后才会使用第 k 名下界剪枝。上界小于下界可跳过；上界恰好
相等时，仅当窗口最小 ID `>=` 第 k 名 ID 才跳过。没有 k 个候选时不会用默认 0
阈值跳过零分文档。所有未排除目录文档（包括无查询词、0 分文档）都参与。

每条 `SkipRecord` 记录：

```text
ID 闭区间
每个查询词项的权重、贡献上界、分数上界
该上界来自的词项块索引及块的 [minID,maxID]
窗口合计分数上界
当时第 k 名分数/ID
使用的剪枝规则
```

`VerifySkipRecords` / `VerifySkipRecordsWithTerms` 只依赖 `IndexMetadata`
和记录本身逐条复核：块范围确实覆盖整个区间、贡献上界等于块实际最大值、
有理数乘法与求和一致、等界时 ID 决胜条件成立、区间内不存在未记录的相交块。

`MemoryStore` 是参考读写存储，每次 `ReadBlock` 返回深拷贝，并提供
`ReadCount`、`TotalReads`。`SearchStats.BlockReads` 可直接观察本次查询读取数；
同一查询内同一块最多读取一次。

## 验证

`go test ./...` 包含：

- 文档 1 贡献 100、后续 8 个块贡献 ≤1、`k=1` 的确定性夹具：只读文档 1 的块，
  至少跳过 8 个后续块。
- 等上界但更小 ID 可入选的否决用例、上界相等时 ID 决胜、词项块边界不齐、
  排除高分文档、空/未知词项、全零权重、跨 `uint32` 及 `math.MaxUint64` ID。
- 随机小目录、全部 k、多组有理权重的全量 posting 独立参考实现对拍。
- 逐条跳过记录元数据复核，以及在原始 posting 上复核区间内实际得分不超过
  记录上界。
- 构建拒绝非法输入、实际块最大值、完整载荷写入及宿主调用 `Example`。

本包不发起网页请求，不包含报表或业务排名逻辑，测试不需要外部搜索服务。
