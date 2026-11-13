# 重叠区间归起点较小的一方

增量导出把主键闭区间分给工人，比较按字节序，两端都包含。采集流水线调用可导入的区间库验收回报。起点大于终点的区间直接失败。起点相同的两个区间也失败，不分配重叠。回报的键必须落在该工人的区间内，否则拒绝这批回报，区间保持未完成。两个区间重叠时，起点较小的一方拥有重叠部分，另一方不得回报重叠键，要在对方起点处停下。区间完成只允许两种情况：最后一键等于终点，或者带耗尽标记且最后一键小于终点。耗尽标记和最后一键等于终点同时出现则区间失败。空回报且没有耗尽标记不算完成。

## 用法

包 `example.org/dataeng13/q0419` 提供 `Validator`。创建时校验区间分配：

```go
validator, err := dataeng.NewValidator([]dataeng.Interval{
    {Start: []byte("a"), End: []byte("m")},
    {Start: []byte("d"), End: []byte("z")},
})
```

`Start > End` 返回 `ErrInvalidInterval`；起点相同的区间返回
`ErrDuplicateStart`，两种情况下都不会创建验证器。

工人的回报通过 `Accept(index, keys, exhausted)` 或
`AcceptReport(index, Report{...})` 提交。一批回报要么全部有效，要么整批
被拒绝，状态不变：

```go
status, err := validator.Accept(1, [][]byte{[]byte("n"), []byte("z")}, false)
```

重叠区间按起点归并：上例中 `[d, m]` 归起点较小的工人 0，因此工人 1 不能
回报 `d` 到 `m`，只能在 `m` 之后继续回报。返回状态为
`StatusComplete`、`StatusIncomplete` 或 `StatusFailed`。完成后再提交回报
会得到 `ErrIntervalFinal`。

结束规则：

- 非耗尽回报的最后键等于终点：完成。
- 耗尽回报的最后键小于终点：完成。
- 耗尽回报的最后键等于终点：失败（`ErrExhaustedAtEnd`）。
- 空回报不带耗尽标记：仍未完成；带耗尽标记：完成（扫描已到数据源末尾）。
