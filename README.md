# 直方图区间重分桶的质量守恒

数据画像宿主调用可导入的Go分桶包，旧桶为不重叠有理端点半开区间及非负整数质量，假定每桶质量沿长度均匀分布；目标边界至少两个且严格递增。输出各目标桶的最简分数质量、左外溢和右外溢，零宽旧桶拒绝，不能把跨桶质量全部放入中点桶。允许负端点和旧桶之间的空洞，不经浮点。提供连续两次重分桶与直接投影不一定相等的实测例子，并用小有理网格参考检查单次质量守恒及端点归属。

## 用法

可导入包位于 `rebucket/`，全程使用 `math/big.Rat` 精确运算：

```go
old := []rebucket.Bucket{
    rebucket.NewBucket(big.NewRat(0, 1), big.NewRat(1, 1), 1),
    rebucket.NewBucket(big.NewRat(1, 1), big.NewRat(2, 1), 3),
}
res, err := rebucket.Rebucket(old, []*big.Rat{
    big.NewRat(0, 1), big.NewRat(1, 2), big.NewRat(2, 1),
})
// res.Masses / res.LeftOverflow / res.RightOverflow 均为最简分数
```

跨桶质量按真实重叠长度比例切分（非中点归属）；`Result.Buckets` 可把结果转回旧桶以支持链式重分桶。运行 `go test ./rebucket/` 可看到网格参考守恒检查及"两次重分桶 ≠ 直接投影"的实测例子。
