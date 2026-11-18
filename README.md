# dlks_formal

可嵌入的 C++20 有界 MPMC 队列组件，header-only，无第三方依赖。

## 语义

- 固定容量 `BoundedMpmcQueue<T, Capacity>`，容量在编译期确定。
- `try_enqueue` / `try_enqueue_batch` 在容量不足时失败，不覆盖已有元素。
- 批量入队是全有或全无的：整批元素在同一个临界区内写入连续逻辑槽位，提交后一次性可见。
- `try_dequeue` 与 `try_dequeue_batch` 只从队首消费；每个元素最多被一个消费者取走。
- `try_enqueue_batch_partial` 接受当前能容纳的前缀；`try_dequeue_batch_exact` 在数量不足时不消费任何元素。
- 提供阻塞式 `enqueue` / `enqueue_batch` / `dequeue` / `dequeue_batch`，用于容量回压和消费等待；`close()` 会唤醒等待者。
- 所有操作通过同一把互斥量建立 acquire/release 发布顺序，因此批量提交对并发消费者是原子的。

## 用法

```cpp
#include "dlks_formal.hpp"

dlks_formal::BoundedMpmcQueue<int, 64> queue;

if (queue.try_enqueue_batch({1, 2, 3, 4})) {
    std::array<int, 4> out{};
    const std::size_t count = queue.try_dequeue_batch(out);
    // count == 4, out == {1, 2, 3, 4}
}
```

## 验证

测试包含：

- 满队列拒绝且不覆盖、环形回绕时的批量全有或全无；
- 用 `NaiveBoundedQueue` 对容量 1 到 4、长度 7 的 6 种操作全部历史做穷举对照，逐次核对入队/出队结果、顺序、大小和容量状态；
- 阻塞批量构造，验证消费者无法看到部分提交的批次；
- 4 生产者、4 消费者并发批量交接，逐元素记录接收次数，验证每个元素恰好被消费一次；
- 阻塞容量回压与 `close()` 唤醒。

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
ctest --test-dir build --output-on-failure
```
