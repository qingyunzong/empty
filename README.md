# tsfill

时间序列缺失段线性补齐库（仅依赖 Go 标准库）。

## 语义

- 样本值为有理数（`math/big.Rat`），插值全程精确有理运算：
  缺口 `(a, b)` 内第 `i` 个点 `v = va + (vb-va)·i/(b-a)`。
- 仅补齐**内部**连续缺失段：两个已知样本之间、长度 `≤ m` 的缺口；
  首样本之前与末样本之后（首尾缺失）一律不补。
- 增量接口 `Series.Add(t, v)` 返回 `Delta{Retracted, Added}`：
  新样本会分裂原有缺口或更新端点值，失效的补齐点进入 `Retracted`，
  新产生/被替换的补齐点进入 `Added`；同时间重复写入视为更新。
- 消费方维护视图：`delete(Retracted)` 后 `set(Added)` 即与全量重算一致。

## 核对方式

`FillAll(samples, m)` 为全量重算参考实现。随机化测试
`TestIncrementalMatchesBatch`（200 组 × 至多 60 步，含重复时间戳）
在**每一步** `Add` 后：校验 Delta 与消费视图自洽（撤回的点是视图中原值），
应用 Delta，再与 `FillAll` 全量结果逐点比对（时间与有理数值完全相等）。

## 实测结果

```
$ go test ./...
ok  	tsfill	0.180s
$ go test -race ./...
ok  	tsfill	1.676s
```

8 个测试全部通过：精确有理插值、缺口长度边界（=m 补 / >m 不补）、
首尾不补、插入分裂缺口产生撤回、整段撤除、重复写入重补、
随机化增量 vs 全量逐步核对。
