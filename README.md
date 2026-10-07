# lockwait-diag

诊断工具：从锁等待日志重建**等待图（wait-for graph）**，逐时刻核验全图模型，
并报告**最短死锁环**及其**来源事件**。

## 语义模型

- 线程可同时持有多个锁；锁支持共享（`S`）与独占（`X`）两种模式。
- 等待边规则：
  - **独占等待被所有持有者阻塞**（无论持有者持 `S` 还是 `X`）；
  - **共享等待只被独占持有者阻塞**；
  - 线程不会阻塞自己（如锁升级场景，自身持有不计入阻塞者）。
- **未完成调用不猜已授锁**：只有出现 `GNT` 的请求才是持有者；
  日志结束前未授锁的请求始终是等待者，绝不臆测为持有。
- **逐时刻全图模型核验**：每消费一个事件，除增量更新外，还用全部历史
  事件从头重放出一个全新模型并比对状态，二者不一致即报错
  （可用 `--no-verify` 关闭）。

## 日志格式

每行一个事件，按时间非递减排列；空行与 `#` 注释被忽略。

```
REQ <time> <thread> <call> <lock> <S|X>   # 线程发起锁请求（开始等待）
GNT <time> <call>                         # 请求被授予（成为持有者）
REL <time> <call>                         # 释放已授予的锁
CAN <time> <call>                         # 取消未完成的请求（如超时）
```

`call` 是调用标识，用于把 `GNT`/`REL`/`CAN` 关联到对应的 `REQ`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 使用

```sh
./build/lockwait-diag examples/deadlock.log     # 或从 stdin 读入：... -
```

输出示例：

```
per-moment full-graph verification: OK (6 of 6 moments)
DEADLOCK first detected at event #6 [t=6] REQ T2 c4 L1 X
shortest deadlock cycle: 2 thread(s)
  T1  T2  (back to T1)
  T1 waits on L2 (X, call c3, requested at event #5)
    blocked by T2 holding L2 (X, call c2, granted at event #4)
  T2 waits on L1 (X, call c4, requested at event #6)
    blocked by T1 holding L1 (X, call c1, granted at event #2)
```

退出码：`0` 无死锁，`1` 发现死锁，`2` 日志/模型错误。

最短环按线程数最少选取，平局时按线程名字典序确定，保证输出可复现；
环上每条边都标注来源事件（等待方的 `REQ` 事件号与阻塞方的 `GNT` 事件号）。

## 布局

- `src/model.hpp` / `src/model.cpp` — 事件解析、锁状态模型、等待图推导、
  最短环检测（BFS）、逐时刻重放核验引擎。
- `src/main.cpp` — 命令行入口。
- `tests/test_main.cpp` — 场景化测试，每个场景注册为独立 CTest 用例。
- `examples/` — 示例日志（互斥死锁、共享锁升级死锁）。
