# runseq

区间序列（游程编码）库：将序列存储为若干连续等值段（run），支持插入、
删除、替换，且每个修改操作都返回可撤销它的逆操作。仅使用 Go 标准库。

## 特性

- 操作坐标均针对**当前**逻辑序列（`off`/`len` 为 `int64`，运算做了溢出检查）。
- 相邻同值段始终自动归并（库内不变量，测试中逐步验证）。
- `Insert` / `Delete` / `Replace`（或统一的 `Apply`）返回逆操作 `Op`：
  - `Insert(off, vals)` → `Delete(off, len(vals))`
  - `Delete(off, n)` → `Insert(off, removed)`
  - `Replace(off, vals)` → `Replace(off, old)`
- 错误：`ErrOutOfRange`（越界）、`ErrOverflow`（总长超 `int64`）、
  `ErrTooLarge`（删除的逆操作需物化被删元素，超出可物化上限时返回）。

## 示例

```go
s := runseq.FromSlice([]int{1, 1, 2, 2})
inv, _ := s.Insert(2, []int{1, 1}) // 1 1 1 1 2 2，自动归并为 2 个 run
s.Apply(inv)                        // 撤销，恢复 1 1 2 2
```

## 测试

```sh
go test ./...
```

测试包含：归并与边界单测、64 位偏移/溢出单测（白盒构造超大 run）、
以及随机操作与朴素切片模型逐步对拍（含逆操作全部回滚校验）。
另有 `FuzzRandomOps` 模糊目标：`go test -fuzz=FuzzRandomOps -fuzztime=30s .`
