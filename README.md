# seqperiods

有限整数串的动态周期查询库（Go）。

周期定义：正整数 `p` 是序列 `a[0..n)` 的周期，当且仅当对所有满足
`i+p < n` 的 `i` 都有 `a[i] == a[i+p]`。不要求 `n` 整除 `p`；
`p >= n` 时恒为（平凡）周期。

## 接口

- `New(values []int64) *Sequence` — 构建，`O(n log n)`
- `s.Set(i, v)` — 单点修改，`O(log n)`
- `s.IsPeriod(p) bool` — 判定单个周期，`O(log n)`
- `s.MinPeriod() int` — 最小周期，`O(n log n)`
- `s.AllPeriods() []int` — `[1, n]` 内全部周期，`O(n log n)`
- `s.FirstMismatch(p) (i, j, ok)` — 周期不成立时的首对位置
  `(i, i+p)`，`O(log^2 n)`
- `s.CheckPeriod(p) (ok, i, j)` — 判定与首对失配位置合一

实现：双模多项式滚动哈希 + 树状数组，支持修改后的区间哈希比较。

## 参考核验

`brute.go` 提供 `O(n^2)` 的全周期扫描参考实现
（`BrutePeriods` / `BruteMinPeriod` / `BruteFirstMismatch`），
测试中用随机短串（含随机单点修改）与快速实现逐一对拍。

## 测试

```sh
go test ./...
```
