# pta — 包含约束指针分析（Andersen 风格）

## 语句（IR）
- `alloc(p, s)`：`p = new`，堆对象按分配点 `s` 区分（`obj@s`）
- `copy(p, q)`：`p = q`
- `load(p, q, f)`：`p = q->f`
- `store(p, f, q)`：`p->f = q`

## 算法
每条语句生成包含约束：
- Alloc：`{obj@s} ⊆ pts(p)`
- Copy：`pts(q) ⊆ pts(p)`
- Load：`∀o ∈ pts(q): fld(o,f) ⊆ pts(p)`
- Store：`∀o ∈ pts(p): pts(q) ⊆ fld(o,f)`

从空解出发迭代传播直到不动点（最小解），循环/环形结构自然收敛。

## 删除语句
`Analysis::remove(id)` 删除语句后，解从空重算（`solve()` 惰性触发），
因此不会保留无支撑别名；测试 `deletion` 将删除后的解与
`analyze(剩余语句)` 从空重算的结果逐一比较，二者相等。

## 构建与测试
```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```
实际结果见 `RESULTS.md`。
