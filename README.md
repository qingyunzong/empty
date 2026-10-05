# gatesim：整数惯性延迟门级电路模拟器

C++20 标准库实现的事件驱动门级模拟器，语义如下：

- **整数惯性延迟**：每个 d>0 的门最多持有一个未到期事件。输入变化使目标值回到当前
  输出时，未到期事件被撤销（窄脉冲宽度 < d 被取消）；宽度 >= d 的脉冲延迟 d 后通过。
- **旧代事件不生效**：每次调度/撤销使门的 token 递增，事件携带签发时的 token；
  到期时 token 不匹配即作为旧代事件丢弃。
- **同 tick 先输入后门更新**：每个 tick 先在 δ0 施加全部外部激励与到期事件，
  然后才求值受影响的门。
- **零延迟用 delta 轮**：d=0 门的输出变化在下一 delta 轮生效，同 tick 内迭代到
  不动点；组合环路超过 `max_delta` 轮抛 `std::runtime_error`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
cd build && ctest --output-on-failure
./gatesim_demo    # 在 build 目录中，打印波形与原因
```

## 文件

- `src/gatesim.hpp` / `src/gatesim.cpp`：模拟器库（信号、门、事件队列、delta 轮）
- `src/main.cpp`：三个演示场景（惯性取消窄脉冲、delta 链、同 tick 输入+事件）
- `tests/test_gatesim.cpp`：7 个用例，期望波形全部手工逐 tick 推算后精确比对
  （时间、δ、电平、原因、日志），含脉冲宽度 == d 边界与零延迟环路不收敛
- `TEST_RESULTS.md`：实际 ctest 与演示输出记录
