# cosched — C++20 协程调度库（手动事件循环）

仅依赖 C++20 标准库（`<coroutine>` 等），核心目标：

- **完成/取消竞争**：`Scheduler::complete(id)` 与 `Scheduler::cancel(id)` 竞争同一个
  waiter，先到先得——认领即擦除登记，等待者**只恢复一次**。
- **销毁即撤销登记**：`Task` 析构时若协程仍挂起，先
  `unregister_by_handle()` 撤销登记再销毁 frame，迟到的 complete/cancel 落空。
- **关闭无悬挂句柄**：`shutdown()` 取消所有待决 waiter（各恢复一次、状态为已取消），
  排空就绪队列；此后 `post`/`register_waiter` 一律拒绝，`no_dangling()` 为真。
- **每 frame 释放统计**：promise 的 `operator new/delete` 记录到 `FrameStats`，
  按事件循环 frame 统计释放次数，并断言每个协程 frame 恰好释放一次。

## 结构

- `include/cosched/scheduler.hpp` — `Scheduler`（手动事件循环）、`WaitOp`、`YieldOp`
- `include/cosched/task.hpp` — `Task` / `promise_type`（含 frame 分配统计）
- `include/cosched/frame_stats.hpp` — `FrameStats`（每 frame 释放计数）
- `tests/` — CTest 用例：completion（竞争）、destroy（撤销登记）、
  shutdown（关闭清理）、frame_stats（释放统计）

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

实际结果见 `TESTING.md`（4/4 通过）。
