# cosched

C++20 协程调度库（仅依赖标准库），手动 frame 驱动的事件循环，核心保证：

- **完成/取消竞争**：每个等待者只被恢复一次。`operation` 的状态机
  `pending -> completed | cancelled` 在互斥锁下转移，先到者认领
  waiter，后到者（包括已投递但未执行的 resume）空转。
- **销毁已挂起任务即撤销登记**：`task::reset()` 在协程挂起时先
  `operation::cancel()` 撤销调度器注册表中的登记，再销毁协程帧，
  之后的 `complete()` 找不到 waiter，不会触碰已死的句柄。
- **关闭不留悬挂句柄**：`scheduler::shutdown()` 取消所有已登记操作、
  以 `operation_cancelled` 恢复各等待者使其自行展开，排空就绪队列并
  拒绝新工作；析构时自动兜底关闭。
- **按 frame 统计释放次数**：每次协程帧销毁都计入发生它的 frame
  （frame 外发生的释放递延到下一 frame），`scheduler::history()`
  给出逐 frame 的 `posted / resumed / freed / timers_fired` 表。

## 结构

- `include/cosched/cosched.hpp` — 全部实现（header-only）
  - `scheduler` — 手动事件循环：`run_frame()` / `run_until_idle()` /
    `shutdown()`，完成源 `make_operation()` 与 `async_delay(frames)`
  - `operation` — 完成/取消状态机与 `wait()` awaitable
  - `task` — 协程任务类型（协程函数首参数须为 `scheduler&`）
- `tests/` — 5 个 CTest 用例：完成、销毁挂起任务、完成 vs 销毁竞争、
  关闭、定时延迟

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

可选 ASan/UBSan 构建：

```sh
cmake -S . -B build-asan -DCOSCHED_SANITIZERS=ON && cmake --build build-asan
ASAN_OPTIONS=detect_leaks=0 ctest --test-dir build-asan --output-on-failure
```

（本沙箱禁用 ptrace，LeakSanitizer 需 `detect_leaks=0`；ASan 内存错误
检查与 UBSan 不受影响。）

生命周期约定：`scheduler` 必须比所有 `task` 与 `operation` 活得久。
实际测试结果见 `RESULTS.md`。
