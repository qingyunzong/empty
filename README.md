# matrixlib — 整数稀疏矩阵增量乘积维护库

维护整数稀疏矩阵 `A`（m×k）与 `B`（k×n），并在每次单元素更正后**增量更新**
`C = A*B`。仅使用 Go 标准库。

## 设计

- `Matrix`（`sparse.go`）：稀疏存储 `map[[2]int]int64`，附行/列倒排索引。
  赋值为 0 即删除该非零项。
- `Engine`（`engine.go`）：持有 `A`、`B`、`C`。
  - `SetA(i,j,v)`：`C` 的第 i 行按 `Δ = v - old` 与 `B` 的第 j 行增量更新；
    `SetB(i,j,v)` 对称地更新 `C` 的第 j 列。
  - 所有新值先算后写：任一步溢出则整体拒绝，`A`/`B`/`C` 与历史均不变。
  - 溢出防护：乘/加/减均用 `math/bits` 做 int64 检查，溢出返回 `ErrOverflow`。
  - `Undo()`：mutation 中直接记录被触及的 `C` 旧值，撤销为纯恢复、不做逆运算。
  - `Snapshot()`：深拷贝 `A`/`B`/`C`，后续改动不影响快照。
  - `DiffSnapshots(id1,id2)` / `DiffCurrent(id)`：逐元素差分（缺失视为 0）。
- `NaiveMultiply`（`naive.go`）：朴素稠密三重循环参考实现；`Engine.Check()`
  用它核对增量维护的 `C`。

## CLI

```
go run ./cmd/matrixcli
dims <aRows> <aCols> <bCols>   创建矩阵（A: m×k, B: k×n）
setA <r> <c> <v>               更正 A 的元素（v=0 删除）
setB <r> <c> <v>               更正 B 的元素（v=0 删除）
undo                           撤销最近一次更正
snap                           保存不可变快照，输出 id
diff <id1> <id2>               快照差分（id2=0 表示与当前状态比较）
show A|B|C                     打印非零项
check                          用朴素三重循环核对 C
quit                           退出
```

## 测试结果

`go test ./...`（另以 `-race -count=1` 复核）实际输出：

```
ok  	matrixlib	1.306s
ok  	matrixlib/cmd/matrixcli	1.036s
```

共 14 个测试全部通过，覆盖：零项删除、越界拒绝、克隆/快照隔离、
溢出边界（`MaxInt64`/`MinInt64` 乘加）、溢出拒绝后状态不变、
随机更正下增量结果与朴素三重循环逐步一致（30 组 × 200 步）、
随机操作序列逐步撤销并逐状态比对、快照间及快照与当前状态差分、CLI 端到端。
