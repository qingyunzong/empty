# traffic-sim

离散时间交通模拟器（C++20）。每 tick 对车辆做通行仲裁，冲突的运动轨迹
占用格集合不能同 tick 通行，并输出配对结果与拒绝理由。

## 语义

- **仲裁顺序**：应急车优先，其次等待时长降序，最后车辆 ID 升序。
  应急车仅提高优先级，不豁免占用格冲突检查。
- **占用格集合**：车辆本 tick 的移动轨迹占用其当前格与下一格
  （防止对向交换与追尾）。集合相交即冲突，按仲裁顺序先到先得。
- **拒绝输出**：每个被拒车辆记录冲突格、占用该格的车辆 ID 及可读理由。
- **等待累加**：被拒车辆等待时长 +1，通行后归零。
- **参考核验**：`verify_no_collision` 校验逐格占用映射无碰撞；
  `verify_waiting` 校验等待时长累加/归零正确。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 运行演示

```sh
./build/traffic_sim_demo
```

每 tick 打印：放行配对（`approved`）、拒绝理由（`rejected`）、
逐格占用映射（`occupancy`）与各车等待时长（`waiting`）。

## 结构

- `src/traffic_sim.h` / `src/traffic_sim.cpp` — 核心库（仲裁、占用、核验）
- `src/main.cpp` — 演示场景
- `tests/traffic_sim_tests.cpp` — CTest 用例（每用例一个独立测试）
