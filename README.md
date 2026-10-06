# partsum

多分区有符号 64 位值的分组求和聚合库。

## 语义

- **精确累加**：内部使用 `big.Int` 累加，中间分区部分和可以任意越出
  int64 范围——后续分区可能将其抵消回界内，不会误拒绝。
- **最终才判越界**：仅当某组的最终和超出 int64 时，该组返回
  `*OverflowError`（含精确大整数和），可用 `errors.As` 判定。
- **逐组错误**：单组越界不影响其他组，调用本身不会整体失败。
- **顺序无关**：分区可以任意乱序到达，结果不变。

## 用法

```go
results := partsum.Sum([]partsum.Partition{
    {Group: "a", Values: []int64{math.MaxInt64, math.MaxInt64}},
    {Group: "a", Values: []int64{-math.MaxInt64, -math.MaxInt64, 42}},
    {Group: "b", Values: []int64{math.MaxInt64, 1}},
})
// a: Sum=42（中间溢出被抵消）
// b: Err=*OverflowError（最终越界，仅该组失败）
```

## 测试

```sh
go test ./...
```

测试覆盖：中间溢出抵消、int64 边界精确值、逐组错误隔离、空输入，
以及固定种子随机用例——随机生成分组/分区/极值混合数据并随机重排
分区顺序，与独立的 `big.Int` 参考实现逐组核验。
