推理引擎需要可嵌入的C++20分页缓存组件，按块分配序列缓存并维护引用计数，处理复制时写与 beam 搜索。块在引用归零前不被复用，共享序列只读引用、分叉时复制，块计数与在途序列精确守恒。用小序列穷举分叉与释放，对照朴素块表核对每块归属与可用块数，beam 扩展与释放交错时不重复占用。

## 组件

`include/dlks_formal.hpp` 提供 header-only 的 `dlks_formal::PagedCache`：

- `create_sequence` / `free_sequence`：序列生命周期，释放时逐块递减引用计数，归零才回收。
- `append` / `set` / `get`：追加与随机读写；写共享块时触发 copy-on-write。
- `fork_sequence` / `beam_expand`：分叉与 beam 扩展，子序列只读共享父序列前缀块。
- `can_append` / `free_block_count` / `block_table` / `refcount`：容量与归属查询。
- `check_invariants`：精确守恒审计（引用计数 == 表槽引用数，空闲表与被引用块不相交，无泄漏）。

## 构建与测试

```sh
cmake -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

测试（`tests/test_paged_cache.cpp`）对照朴素块表模型：

- 小序列穷举分叉 / 追加 / 改写 / 释放的全部交错，逐状态核对每块归属与可用块数。
- 随机模糊（300 种子 × 400 操作）验证数据完整性与守恒。
- beam 扩展与释放交错，确认块不重复占用且池最终完整回收。
