# resource_batch

C++20 资源批次申请库（header-only，`include/resource_batch.hpp`）。

## 语义

- `acquire_batch(count, acquire, release)`：依次调用 `acquire(i)` 申请 `count` 个资源，
  每个资源包装为 `Handle` 并以 `std::vector<Handle>` 返回。
- 第 k 项申请失败：已取得的 k 个资源按**逆序**（k-1 … 0）释放，随后抛出
  `AcquireError`（携带 `index` 与 `release_errors`）。
- `Handle`：可移动、不可复制（含 `static_assert` 保证）；析构/移动赋值/`reset()`
  均保证每个资源**恰好释放一次**；移动后源句柄失效（inert）。
- 释放回调可抛异常：析构与回滚路径均捕获异常，**仍继续清理其余项**；
  回滚中抛异常的回调次数计入 `AcquireError::release_errors`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
cd build && ctest --output-on-failure
```

## 测试覆盖（tests/test_resource_batch.cpp）

1. 全部成功：5 个句柄各释放恰好一次，存活期间零释放。
2. 失败注入：n=6 时 k=0..5 逐项注入，核对释放轨迹恰为逆序 [k-1 … 0]，
   且 `AcquireError::index == k`。
3. 释放回调抛异常（id=102）：轨迹仍为完整逆序 {104,103,102,101,100}，
   `release_errors == 1`。
4. 移动链：移动构造 → 移动赋值 → 移动赋值顶替旧资源（旧资源先释放一次）
   → 自移动赋值；最终 42 仅释放一次，轨迹 {77, 42}。
5. `reset()` 幂等：手动 reset 后析构不重复释放。
6. 空批次与 `fail_at == count`（不注入）边界。

## 实测结果（GCC 15.2.0, CMake 4.2.3, C++20, -Wall -Wextra -Wpedantic）

```
53 checks, 0 failures
1/1 Test #1: resource_batch ...................   Passed    0.05 sec
100% tests passed, 0 tests failed out of 1
```
