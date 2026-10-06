# netsim — 逐字节离散时间网络模拟器

按整数 tick 推进的共享链路带宽模拟器（C++20）。

## 语义

- **Tick 调度**：每条链路每 tick 最多转发其容量（字节）的数据。
- **按 ID 轮转**：同一链路上，就绪流按流 ID 升序轮转，每轮每流发 1 字节，
  直到容量或数据耗尽。
- **同刻新增下一轮参与**：tick t 加入的流从 tick t+1 起参与调度。
- **取消仅撤未发字节**：`cancel_flow` 只撤销尚未离开源点的字节（含首链路
  队列中未发者）；已在途字节继续转发并正常投递。
- **多跳下一 tick 可发**：tick t 穿过某链路的字节，tick t+1 才可在下一跳
  发送。
- **字节守恒账**：每流及全局满足
  `size == delivered + in_flight + revoked + unsent`。

## 构建与测试

```sh
cmake -B build
cmake --build build
ctest --test-dir build --output-on-failure
./build/netsim_cli   # 演示场景：打印事件日志与守恒账
```

## 结构

- `src/simulator.hpp` / `src/simulator.cpp` — 模拟器库（`netsim::Simulator`）
- `src/main.cpp` — 演示 CLI，输出逐字节事件与守恒账
- `tests/reference.hpp` — 独立参考模型（逐字节对象实现）
- `tests/test_basic.cpp` — 容量、ID 轮转、同刻新增下一轮参与
- `tests/test_cancel.cpp` — 取消语义（未发撤销、在途照投、幂等性）
- `tests/test_multihop.cpp` — 多跳流水线、合流、瓶颈积压
- `tests/test_reference.cpp` — 200 个随机场景下主模拟器与参考模型的
  逐字节日志比对 + 每 tick 守恒校验
