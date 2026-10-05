# bq::bounded_queue — C++20 有界阻塞队列

基于 `std::mutex` + `std::condition_variable` 的有界 MPMC 阻塞 FIFO 队列，
仅依赖 C++20 标准库，头文件库：`include/bq/bounded_queue.hpp`。

## 保证

- **强异常保证**：元素在队列槽位内原位构造（`std::optional<T>` 环形缓冲）。
  - `push/emplace/try_emplace` 中元素构造或移动抛异常：槽位保持空闲，
    `tail_`/`count_` 不变 —— 容量与原队列内容完整保留。
  - `pop/try_pop` 中移动头部元素抛异常：元素留在队列中，可再次取出。
- **close 语义**：`close()` 唤醒所有阻塞的生产者和消费者；之后
  `push` 返回 `false`；队列中剩余元素可继续 `pop` 排空，排空后
  `pop` 返回 `std::nullopt`。
- **线性化**：所有操作在同一把互斥锁内完成状态变更，线性化点明确。

## API 摘要

| 操作 | 语义 |
| --- | --- |
| `emplace/push` | 阻塞直到有空位或关闭；关闭时返回 `false` |
| `try_emplace/try_push` | 非阻塞；关闭或满时返回 `false` |
| `pop` | 阻塞直到有元素或关闭且排空；返回 `std::optional<T>` |
| `try_pop` | 非阻塞；空时返回 `std::nullopt` |
| `close` | 幂等；唤醒全部等待者 |
| `size/capacity/closed` | 状态查询 |

## 测试

- `test_basic`：FIFO 顺序、容量上限、`try_*` 变体、move-only 元素。
- `test_exception_safety`：可控异常元素 `tracked`（`arm(n)` 倒数第 n 次
  构造抛出、`throw_on_copy/throw_on_move` 开关），验证构造/拷贝/移动
  抛出时容量与内容保持、pop 抛出时元素保留；每阶段核对
  `constructed == destructed`、`double_destroys == 0`、无泄漏。
- `test_close`：`std::barrier` 同步的多生产者/消费者，验证 close 唤醒
  阻塞双方、剩余元素按 FIFO 排空、并发关闭时每个成功入队的元素
  恰好被取出一次（逐值位图核对）。
- `test_linearizability`：SPSC 精确顺序核对 + 4 生产者/4 消费者压力
  测试，记录每次操作的全局 tick 区间，事后构建优先图（push→pop、
  实时序、按生产者 FIFO 边），Kahn 拓扑排序验证存在线性化；并核对
  每个值恰好入队/出队一次、全程无重复析构。

## 构建与运行

```sh
cmake -S . -B build
cmake --build build -j
cd build && ctest --output-on-failure
```

可选 sanitizer：`-DBQ_SANITIZE=address|undefined|thread`。

## 实际测试结果（GCC 15.2.0，CMake 4.2.3，16 核，2026-10-06）

默认构建（RelWithDebInfo，`-Wall -Wextra -Wpedantic` 无警告）：

```
1/4 Test #1: test_basic .......................   Passed    0.03 sec
2/4 Test #2: test_exception_safety ............   Passed    0.02 sec
3/4 Test #3: test_close .......................   Passed    0.16 sec
4/4 Test #4: test_linearizability .............   Passed    0.29 sec
100% tests passed, 0 tests failed out of 4
```

AddressSanitizer 构建（`-DBQ_SANITIZE=address`，沙箱环境不支持 LSan，
以 `ASAN_OPTIONS=detect_leaks=0` 运行；泄漏由测试内构造/析构计数核对）：

```
100% tests passed, 0 tests failed out of 4   (Total Test time = 2.13 sec)
```

ThreadSanitizer 构建（`-DBQ_SANITIZE=thread`，无数据竞争报告）：

```
100% tests passed, 0 tests failed out of 4   (Total Test time = 5.60 sec)
```

并发稳定性：`ctest --repeat until-fail:20 -R 'test_close|test_linearizability'`
20 轮全部通过。
