# motion：一维粒子接触模拟库

模拟一维整数位置、有理速度粒子的运动。相邻粒子接触时交换速度；
同一时刻多粒子接触按**连续接触组**整体反转速度顺序。所有事件时间
以任意精度有理数精确输出；零距初态（初始即同位的粒子）作为
`t = 0` 的事件最先处理。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 库接口（C++20）

```cpp
#include <motion/simulation.hpp>

std::vector<motion::Particle> particles = {
    {motion::Rational(0), motion::Rational(2)},   // 位置 0，速度 2
    {motion::Rational(1), motion::Rational(1)},
    {motion::Rational(2), motion::Rational(0)},
};
motion::Simulation sim(std::move(particles));     // 粒子须按位置非降排列
while (auto event = sim.step()) {
    // event->time    ：精确有理数时刻（event->time.to_string()）
    // event->groups  ：该时刻的连续接触组 [first, last]，组内速度已反转
}
```

- `motion::BigInt`：任意精度有符号整数。
- `motion::Rational`：最简有理数（分母恒正、分子分母互素）。
- `motion::Simulation::run(max_events)`：连续推进并返回事件序列。

## 演示程序

```sh
printf '3\n0 2 1\n1 1 1\n2 0 1\n' | ./build/motion_cli
# 输入：粒子数 n，随后每行「位置 速度分子 速度分母」
# 输出：t = 1 : group [0,2]
```

## 测试

- `test_bigint_rational`：任意精度整数与有理数的运算、约分、比较。
- `test_simulation`：小系统场景——对撞、追赶、同刻多粒子组、
  零距初态优先处理、同刻多独立组、零距链式解析、分数事件时间。
- `test_reference`：细分事件参考核验——参考实现把每个接触时刻细分为
  相邻两两交换序列，与库实现的组反转在不同时刻序列与最终状态上
  完全一致；并对 300 个随机小系统（含零距初态与有理速度）交叉核验
  事件时间、最终状态、速度多重集守恒、动量守恒与无穿透不变式。
