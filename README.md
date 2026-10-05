# gatesim — 整数惯性延迟门级仿真器（C++20）

事件驱动数字逻辑仿真器，语义如下（离散 tick，整数延迟）：

1. **整数惯性延迟**：每个门有整数延迟 `d >= 0`。宽度 `w < d` 的输入脉冲被
   惯性取消，不产生输出变化；`w >= d` 的脉冲通过（输出延迟 `d` 个 tick）。
2. **旧代延迟事件不生效**：每次调度事件时门的代际号 `gen` 递增，事件携带
   当时的 `gen`；事件出队时若 `gen` 已过期（被更新的事件取代/取消）则跳过，
   并记录到 stale 列表。
3. **同 tick 先输入后门更新**：每个 tick 内顺序为
   `施加外部输入 -> 到期事件触发 -> 零延迟 delta 收敛 -> 延迟门重调度`。
   预定在 tick `t` 触发的事件即使输入在 `t` 变化也照常触发（tick `t` 的输入
   只取消触发时间 `> t` 的事件），因此宽度恰等于延迟的脉冲也能通过。
4. **零延迟用 delta 轮**：`d = 0` 的门在同一 tick 内按原子 delta 轮迭代
   （轮初采样、轮末统一下发）直到收敛，变化记录携带 delta 序号。

## 目录

- `src/gatesim.hpp` / `src/gatesim.cpp` — 仿真器库（仅依赖 C++20 标准库）
- `src/demo.cpp` — 4 个演示场景，打印波形与每次变化/取消/旧代跳过的原因
- `tests/reference_model.hpp` — 独立的逐 tick 参考模型（不用事件队列）
- `tests/test_main.cpp` — 定向测试 + 200 个随机种子与参考模型逐 tick 核对

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
./build/gatesim_demo        # 打印波形与原因
```

实际测试结果见 `TEST_RESULTS.md`。
