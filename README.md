# dlks_formal

可嵌入的 C++20 NUMA 固定页内存池。组件为 header-only，不依赖底层运行时；
拓扑、页预算和 NUMA 距离均由调用方提供，便于在测试中模拟不同机器。

## 设计

- 每个 NUMA 节点拥有一段按 `page_size` 对齐的固定页 arena，页数即该节点的硬预算。
- 每线程、每节点、每池维护独立缓存；缓存会成批从本地节点补充，减少中央锁竞争。
- 本地节点页用尽时按模拟距离矩阵从近到远借用。缓存持有的远端页达到
  `borrow_threshold` 后，每次分配/释放最多归还 `return_batch` 页，逐步回收到所属节点。
- `max_remote_pages` 是每缓存远端页的硬上界，已分配但尚未释放的远端页也计入其中。
- 页经过 `free -> cached -> allocated -> recycling` 原子状态转换；缓存回收使用一次性
  `retired` 状态。线程退出、显式回收和并发 `release_page` 竞争时，每页只会进入一个位置。
- `audit()` 遍历中央空闲表和所有存活缓存，检查重复归属、遗漏页、节点预算与远端上界。

## 使用

```cpp
#include "dlks_formal.hpp"

dlks::NumaTopology topology =
    dlks::NumaTopology::from_page_counts({256, 256, 128});

dlks::NumaPoolConfig config;
config.page_size = 4096;
config.local_batch = 4;
config.local_cache_limit = 16;
config.borrow_threshold = 8;
config.return_batch = 2;
config.max_remote_pages = 16;

dlks::NumaPagePool pool(topology, config);

dlks::Page* page = pool.acquire_page(/*preferred_node=*/0);
if (page != nullptr) {
    // page->data() 提供 page->size() 字节；page->home_node() 是物理页所属节点。
    pool.release_page(page);
}

pool.reclaim_current_thread();  // 线程退出时也会自动执行
```

`acquire_page()` 在首选节点和允许的远端预算都耗尽时返回 `nullptr`。它分配的是整页，
不承担任意大小对象的 size-class 分层。`page_size` 必须是 2 的幂且不小于
`alignof(std::max_align_t)`。

## 观测

- `statistics()` 返回各节点预算、中央空闲页、缓存页、活动页、远端借用/归还次数、
  每缓存远端页峰值及双重释放拒绝次数。
- `audit()` 适合无并发操作的检查点，返回页唯一归属与预算守恒结果。
- `reclaim_all_threads()` 可与分配线程并发调用；后续分配会自动建立新缓存。

## 构建与验证

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试使用模拟的非均匀拓扑，覆盖固定页唯一归属、预算守恒、借用阈值后的逐批归还、
每缓存远端页上界、双重释放拒绝，以及随机并发的分配/释放/线程退出/全局回收。
