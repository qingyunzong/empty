# motion1d

一维粒子运动模拟库（C++20，头文件库）。

## 模型

- 粒子初始位置为整数，速度为有理数；所有事件时间与位置均为**精确有理数**
  （`motion::Rational`，64 位存储、128 位中间运算、溢出即抛异常，绝不近似）。
- 相邻粒子接触时交换速度（等质量弹性碰撞），因此粒子的左右顺序是不变量。
- 同一时刻多粒子接触时，相碰的相邻对连成**连续接触组**，组内速度序列
  **整体反转**；若反转后同刻仍存在零距碰撞，则继续在同一时刻求解，
  直至该瞬间完全分离（同一时刻可能产生多个事件）。
- 零距初始态视为 `t = 0` 的接触，先于一切后续事件处理。

## API 摘要（`include/motion/simulator.hpp`）

```cpp
motion::Simulator sim({{0, 0, motion::Rational(2)},
                       {1, 3, motion::Rational(0)},
                       {2, 6, motion::Rational(-1)}});
sim.run_until(motion::Rational(2));   // 处理所有 time <= 2 的事件
for (const motion::Event& e : sim.events())
  // e.time 为精确有理数；e.groups 为各接触组的粒子 id（从左到右）
auto snap = sim.snapshot(motion::Rational(2)); // 精确位置与速度
```

- `step()`：处理下一个求解轮次，返回该事件（无后续事件时返回 `std::nullopt`）。
- `run(max_rounds)` / `run_until(t)`：批量推进。
- `next_event_time()`：查看下一事件时间。
- `snapshot(t)`：任意 `t >= time()` 时刻的精确位置/速度（按左右顺序）。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试（CTest）：

- `test_rational`：有理数规范化、四则运算、比较、异常（零分母、溢出）。
- `test_simulator`：确定性场景——精确事件时刻、三体/四体同刻整体反转、
  同刻不相交接触组、零距初态优先、同刻级联、`run_until` 边界。
- `test_reference`：500 组随机小系统（含零距初态），与逐对交换的
  细分参考实现逐步交叉核验：事件时刻集合、每事件后的位置与速度、
  同刻完全分离后的不变量（重合粒子速度不减）、末态自由飞行。
