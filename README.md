# blocking_queue — 有界阻塞 MPMC 队列（C++20）

基于固定容量环形缓冲（`std::vector<std::optional<T>>`）+ 互斥锁 + 两个条件变量的
多生产者多消费者阻塞队列，仅使用 C++20 标准库。

## 语义保证

- **强异常保证**：`push`/`emplace` 中若 `T` 的构造抛异常，槽位保持空闲，容量、
  大小与原有内容完全不变，异常向外传播；`pop` 中若移动构造抛异常，队首元素
  保留在队列中，队列状态不变。
- **关闭语义**：`close()` 唤醒所有阻塞中的生产者与消费者。生产者的 `push`
  返回 `false`；消费者可继续排空剩余元素，`pop` 仅在队列已关闭且为空时返回
  `std::nullopt`。`close()` 幂等。
- **可线性化**：所有公共操作在互斥锁内确定其线性化点（见测试验证）。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build -j
cd build && ctest --output-on-failure
```

## 测试设计

- `tests/counted.hpp` — 可控异常元素 `Counted`：可设定“第 N 次构造抛出”或
  “移动构造必抛”；全局存活注册表记录每个对象的序列号，析构时发现序列号
  不存在即记为重复析构；构造/析构计数器用于核对平衡（无泄漏）。
- `exception_safety_test` — 构造抛异常时容量与内容保持、满队列拒绝时不消耗
  槽位、移动抛异常时队首保留、反复异常后队列可恢复；每轮结束核对
  `constructions == destructions`、`double_destructions == 0`。
- `close_test` — 用 `std::barrier` 同步启动：关闭唤醒阻塞的生产者（全部返回
  `false`）与消费者（全部返回 `nullopt`）；关闭后 200 个剩余元素被 4 个消费者
  恰好各排空一次（排序后与期望值逐一比对）；关闭幂等。
- `linearizability_test` — 4 个worker线程经 `std::barrier` 同时起跑，在小容量
  队列上随机执行 `try_push`/`try_pop` 并随机注入构造/移动异常，另有线程并发
  `close()`；每次操作记录 invoke/response 时间戳构成历史，随后用 Wing-Gong
  回溯算法对照“有界队列 + 关闭”的顺序规约验证整个历史可线性化。检查器带
  自检：FIFO 违反、凭空弹出、满队列假成功等非法历史必须被拒绝。运行结束核对
  无重复析构、无泄漏。

## 实际测试结果（本机 GCC 15.2 / CMake 4.2.3）

```
$ cd build && ctest --output-on-failure
1/3 Test #1: exception_safety_test ............   Passed    0.03 sec
2/3 Test #2: close_test .......................   Passed    0.27 sec
3/3 Test #3: linearizability_test .............   Passed    0.03 sec
100% tests passed, 0 tests failed out of 3

$ ./exception_safety_test
exception_safety_test: all checks passed (constructions=200, destructions=200, double_destructions=0)
$ ./close_test
close_test: all checks passed
$ ./linearizability_test
linearizability_test: checking 49 operations... done in 0 ms
linearizability_test: history is linearizable; constructions=14, destructions=14, double_destructions=0
```

稳定性与清理工具验证：

- 重复运行：`linearizability_test` 100/100 通过，`close_test` 30/30 通过，
  `exception_safety_test` 30/30 通过。
- ThreadSanitizer 构建（`-fsanitize=thread`）：3/3 通过，无数据竞争报告。
- AddressSanitizer + UBSan 构建（`-fsanitize=address,undefined`）：3/3 通过
  （本环境 ptrace 受限，LeakSanitizer 以 `detect_leaks=0` 关闭；泄漏由
  `Counted` 的构造/析构计数与存活注册表核对覆盖）。

## 文件结构

- `include/blocking_queue.hpp` — 队列库（header-only）
- `tests/counted.hpp` — 可控异常测试元素
- `tests/exception_safety_test.cpp`、`tests/close_test.cpp`、
  `tests/linearizability_test.cpp` — CTest 测试
