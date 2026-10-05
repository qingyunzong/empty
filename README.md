# pagefile — 可扩容页文件库（C++20）

只读视图可跨线程持有；扩容与关闭不会使既有视图悬空；关闭后拒绝新视图；
最后一个视图释放时才解除映射。仅依赖 C++20 标准库，映射后端可替换。

## 设计

- `pagefile::IMapper`（`include/pagefile/mapper.hpp`）：映射策略接缝。
  `map(size)` 返回一块映射，`unmap(mapping)` 释放（`noexcept`）。测试用
  `CountingMapper` 替换以核对 map/unmap 次数；默认后端 `HeapMapper`
  纯标准库实现，生产可替换为 mmap/VirtualAlloc 后端。
- `pagefile::PageFile`（`include/pagefile/page_file.hpp`）：
  - `acquire()` 返回 `std::optional<View>`；关闭（或移出）后返回 `std::nullopt`。
  - `View` 通过 `shared_ptr<Holder>` 共享持有某一代映射，可复制/移动，
    可安全地跨线程持有与析构；`Holder` 析构时调用 `unmap`。
  - `expand(new_size)` 分配新一代映射并拷贝旧内容，旧代映射由既有视图
    继续持有，不会被解除映射或改写——视图是获取时刻的快照。
  - `close()` 幂等：拒绝后续 `acquire`，并释放文件自身对当前映射的引用；
    若仍有视图存活，解除映射推迟到最后一个视图释放。
  - `acquire/expand/close/is_closed/size` 均可多线程并发调用（内部互斥锁）；
    `write/fill` 修改当前代映射，需与读者外部同步。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

可选 `-DPAGEFILE_SANITIZERS=ON` 启用 ASan/UBSan（沙箱中自动关闭 LSan，
释放次数由 `CountingMapper` 精确核对）。

## 测试

- `tests/basic_test.cpp`：关闭语义、延迟解除映射、扩容保留旧视图、
  移动语义、视图拷贝生命周期、错误路径。
- `tests/interleaving_test.cpp`：对 6 种操作（获取/关闭/扩容/移动视图/
  移动 PageFile/释放视图）穷举全部 6^6 = 46656 条长度为 6 的交错序列，
  每步核对：视图内容与大小不悬空、引用存续期间 `live >= 1`、
  无引用时 `live == 0`、结束时 `map_calls == unmap_calls`。
- `tests/threading_test.cpp`：8 个工作线程并发获取/读取/释放视图，
  主线程扩容 64 次后关闭；核对读取内容始终为有效代字节、
  关闭后获取被拒绝、全部映射恰好释放一次。

## 实际测试结果

环境：GCC 15.2.0，CMake 4.2.3，Linux x86-64（16 核），2026-10-05。

默认构建（RelWithDebInfo，`-Wall -Wextra -Wpedantic -Werror`）：

```
1/3 Test #1: basic_test .......................   Passed    0.00 sec
2/3 Test #2: interleaving_test ................   Passed    0.07 sec
3/3 Test #3: threading_test ...................   Passed    0.01 sec
100% tests passed, 0 tests failed out of 3
```

其中 `interleaving_test` 输出 `enumerated 46656 interleavings of 6 ops
(length 6)`，`threading_test` 输出 `workers=8 expansions=64
views_acquired=... rejected=...`（均大于 0）。

ASan/UBSan 构建（`-DPAGEFILE_SANITIZERS=ON`）：

```
1/3 Test #1: basic_test .......................   Passed    0.01 sec
2/3 Test #2: interleaving_test ................   Passed    0.55 sec
3/3 Test #3: threading_test ...................   Passed    0.02 sec
100% tests passed, 0 tests failed out of 3
```
