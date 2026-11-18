# dlks_formal 页缓存

面向操作系统存储层的可嵌入 C++20 页缓存。单头文件、无外部依赖、固定帧数；
页加载与回写通过回调交给宿主存储层。

## 快速使用

```cpp
#include <dlks_formal.hpp>

using cache_type = dlks_formal::page_cache<std::vector<std::byte>>;

dlks_formal::page_cache_options options;
options.capacity = 128;
options.lru_sample_size = 32;
options.dirty_high_watermark = 96;
options.dirty_low_watermark = 48;
options.writeback_batch = 16;

cache_type cache(
    options,
    [](const std::uint64_t& page_no) {
      return read_page_from_backing_store(page_no);  // optional<Value>
    },
    [](const std::uint64_t& page_no, const std::vector<std::byte>& data) {
      return write_page_to_backing_store(page_no, data);  // bool
    });

auto page = cache.acquire(42);
if (page) {
  auto& bytes = page->value();
  bytes[0] ^= 0x5a;
  page->mark_dirty();       // 回写前该页不会进入回收候选
  page->touch();            // 可选：刷新长持有句柄的 LRU 时间戳
}                           // 句柄析构 -> 解除 pin

cache.throttle();           // 超过高水位时回写到低水位
(void)cache.reclaim(8);     // 只回收干净、未 pin 的页
```

## 回收策略

- 每帧记录 `last_access`。命中会推进逻辑时钟并刷新该时间戳。
- 回收从旋转的 `hand_` 开始，默认最多检查 `lru_sample_size` 个常驻帧，
  选择其中最久未访问的**干净且未 pin**帧。这是采样近似 LRU。
- 若采样窗口内没有合格帧，会退化为全帧扫描，避免因为采样点恰好都是脏页
  或在用页而错误地回收失败。
- `lru_sample_size == 0` 或大于等于 `capacity` 时，选择结果等价于朴素 LRU：
  在全部干净、未 pin 页中选择最久未访问者。测试正是用这个模式与独立模型
  逐条比对回收顺序和脏页集合。
- `reclaim()` 返回按顺序被驱逐的键；隐式插入驱逐可通过
  `take_evictions()` 读取诊断日志。

## 脏页、回写与节流

- 写入路径：调用方修改 `handle::value()` 后调用 `handle::mark_dirty()`。
- 脏页永远不会被 `reclaim()` 选中；即使已经发起回写，只要
  `writeback_inflight` 仍为真，也不会被驱逐。
- 回写会在元数据锁内复制一份值快照，然后**在锁外**调用 writer 回调。
  回写完成后：
  - 若脏版本未变化，页变干净并计入 `writebacks_cleaned`；
  - 若期间又被 `mark_dirty()`，保留脏状态并计入 `writebacks_stale`。
- `throttle()` 仅在 `dirty > dirty_high_watermark` 时启动，按
  `writeback_batch` 分批回写，直到 `dirty <= dirty_low_watermark`。
- `auto_throttle=true` 时，`acquire()` 和 `mark_dirty()` 会自动触发节流。
- `writeback_on_pressure=true` 时，插入新页找不到空闲帧会尝试一次回写后重试。
- 水位会被归一化到容量以内；例如只覆盖 `capacity` 时，
  `dirty_high_watermark` 最大为 `capacity - 1`，保证自动节流仍可触发。

## 并发模型

- 所有帧、索引、水位和计数器由一个互斥量保护。
- `acquire()` 返回只可移动的 `handle`。句柄存活期间对应帧被 pin，
  引用计数非零的页不会被回收。
- 加载器和回写器都在锁外执行，可以执行慢 I/O；但不应递归调用同一个缓存
  实例的会阻塞的操作。
- 命中与回收通过同一把锁线性化：回收选中的页在选中时没有 pin；
  若另一线程随后命中，则得到的是回收后的重新加载结果，不会访问已释放帧。
- 页内容本身的读写同步由调用方负责。缓存保证帧的生命周期和元数据安全，
  不保证多个句柄并发写同一 `Value` 时无数据竞争。
- 所有 `handle` 必须在 `page_cache` 析构前销毁。

## 计数守恒

`page_cache::validate()` 在锁内检查全部结构不变量和以下计数关系：

```text
accesses             == hits + misses
misses               == loaded + coalesced + not_found + load_errors + no_space
resident             == insertions - evictions
dirty_transitions    == writebacks_cleaned + dirty
writeback_requests   == writebacks_completed + writeback_failures + inflight
writebacks_completed == writebacks_cleaned + writebacks_stale
```

其中 `dirty_transitions` 只统计“干净 -> 脏”的状态转换。一次脏状态可能在
回写期间再次被修改，因此用版本号区分“真正清干净”和“陈旧回写”。
这样即使回写与再脏化交错，脏页转换、有效回写和当前脏页数仍严格守恒。

`page_cache_stats` 还提供访问、加载、驱逐、回写失败、常驻/脏/在用帧数量等
计数，便于嵌入方观测。

## 验证

`tests/page_cache_test.cpp` 与 `tests/lru_model.hpp` 覆盖：

- 命中/缺失/加载失败/空页的计数守恒；
- 脏页在回写完成前不可回收，回写后可回收；
- 全采样模式下与独立朴素 LRU 模型进行 20,000 步随机差分，
  逐条比较驱逐顺序、常驻集合、脏页集合和计数；
- 小采样窗口下“只驱逐干净且未 pin 页”的结构不变量；
- 高/低水位节流、批量回写及自动节流；
- 回写期间再次置脏时的 stale 计数；
- 回写与回收交错时，持有句柄的页不被驱逐；
- 多线程命中、置脏、回收、回写压力下 `validate()` 始终成立。

构建并运行：

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试已在 ASan/UBSan 与 TSan 下通过。
