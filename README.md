# points-to 静态分析库（Andersen 风格，C++20）

基于包含约束（inclusion constraints）的过程内 points-to 分析，求解最小
points-to 集合。仅依赖 C++20 标准库。

## 语句模型

| 语句 | 含义 | 包含约束 |
|---|---|---|
| `alloc(p, A)` | `p = new A` | `pts(p) ⊇ {alloc:A}` |
| `addr_of(p, x)` | `p = &x` | `pts(p) ⊇ {stack:x}` |
| `copy(p, q)` | `p = q` | `pts(p) ⊇ pts(q)` |
| `store(p, f, q)` | `p->f = q` | `∀o ∈ pts(p): fld(o,f) ⊇ pts(q)` |
| `load(p, q, f)` | `p = q->f` | `∀o ∈ pts(q): pts(p) ⊇ fld(o,f)` |

- 堆对象按分配点区分（`alloc:<site>`），栈对象按变量名（`stack:<var>`）。
- `Analyzer::solve()` 从空状态迭代应用约束直到不动点，得到最小解；
  自引用结构（如 `p->next = p`）经有限轮收敛。
- 语句可通过 `remove(id)` 删除。任何变更后 `solve()` 从空重算，
  因此不会保留失去支撑的别名；测试将其与"全新 Analyzer 只含剩余
  语句"的重算结果逐一比对（`deletion_consistency`、`delete_all`）。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 实际测试结果（2026-10-05，GCC 15.2.0，CMake 4.2.3）

```
Test project .../build
    Start 1: copy_and_alloc
1/6 Test #1: copy_and_alloc ...................   Passed    0.00 sec
    Start 2: field_store_load
2/6 Test #2: field_store_load .................   Passed    0.00 sec
    Start 3: fixpoint_cycle
3/6 Test #3: fixpoint_cycle ...................   Passed    0.00 sec
    Start 4: alloc_site_distinction
4/6 Test #4: alloc_site_distinction ...........   Passed    0.00 sec
    Start 5: deletion_consistency
5/6 Test #5: deletion_consistency .............   Passed    0.00 sec
    Start 6: delete_all
6/6 Test #6: delete_all .......................   Passed    0.00 sec

100% tests passed, 0 tests failed out of 6
```

## 文件结构

- `include/pta/points_to.hpp` — 语句、状态与求解器接口
- `src/points_to.cpp` — 约束转移与不动点求解实现
- `tests/test_points_to.cpp` — 6 个 CTest 用例
