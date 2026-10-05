# intervalset

整数集合库：元素成员资格表示为多个有效半开区间 `[Lo, Hi)` 的规范列表
（有序、互不相交、不相邻），每个区间携带排序去重后的来源标签作为证据。

## 功能

- `NewSet(name)` / `AddInterval(iv, src)` / `RemoveInterval(iv)`：
  区间增删；重叠或相邻区间自动归并，来源标签取并集，证据不丢失。
- `Add(x, src)` / `Remove(x)`：单成员更正，增量更新（局部归并/收缩/分裂），
  不重建整个区间列表。
- `Intersect(sets...)`：多集合交集查询，返回 `[]RInterval`；相邻结果段
  归并为一个区间，每段保留每个输入集合的来源证据（`Evidence`，按集合名排序）。
- `Contains(x)` / `Intervals()` / `Canonical(ivs)` / `String()`：
  成员查询与规范输出核对。

## 测试

`intervalset_test.go` 包含表驱动单元测试，以及小整数域逐 tick 核对
（`TestSmallDomainPerTick`）：域 `[0,24)`、4 个集合、2000 tick 随机
区间/单成员增删，每 tick 校验：

1. 每个集合的区间列表处于规范形式（`Canonical`）；
2. 成员资格与逐元素布尔模型一致；
3. 多集合交集与暴力模型一致，且证据完整、规范、标签均真实存在。

## 实际测试结果

```
$ go test ./...
ok  	intervalset	0.102s

$ go test -race -count=1 ./...
ok  	intervalset	1.269s
```

（Go 1.27.1 linux/amd64，仅使用标准库。）
