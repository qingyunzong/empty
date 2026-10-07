# 交通模拟器 (traffic_sim)

基于网格的逐 tick 交通模拟器, C++20。

## 规则

- **仲裁顺序**: 每 tick 按 应急车优先 → 等待时长降序 → 车辆 ID 升序 依次裁决。
- **占用模型**: 车辆申请通行时占用 `{当前格, 目标格}` 两格; 若目标格在 tick 开始时被其他车辆占用,
  或申请集合与本 tick 已确认的占用格相交, 则拒绝通行, 车辆留在当前格 (仍占用当前格)。
  不做链式跟随 (目标格占位者即使本 tick 移走, 仍视为占用), 保证保守无碰撞。
- **应急车**: 仅提高仲裁优先级, 不豁免任何占用冲突规则。
- **等待累加**: 被拒车辆 `wait` 与 `total_wait` 各加 1; 通行后 `wait` 归零。
- **输出**: 每 tick 输出 车辆↔占用格 配对 (`Reservation`)、拒绝及理由 (`Rejection`,
  含冲突格与冲突车辆)、到达名单。
- **核验**: `verifyTick(before, report)` 作为参考实现, 由 tick 前状态与报告决策独立重算,
  逐格检查占用互斥 (无碰撞)、配对合法、等待累加一致、拒绝理由指向真实冲突。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
./build/traffic_demo   # 演示: 十字路口场景, 逐 tick 打印配对/拒绝理由/核验结果
```

## 结构

- `include/trafficsim/simulator.hpp` — 数据结构与接口
- `src/simulator.cpp` — 仲裁、占用、核验实现
- `src/main.cpp` — 十字路口演示
- `tests/test_simulator.cpp` — 测试用例 (经 CTest 逐条注册)
