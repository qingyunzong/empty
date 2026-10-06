# netsim — 整数 tick 共享链路带宽模拟器

C++20 实现的离散时间网络模拟器，附 CMake/CTest 可执行测试。

## 语义

- **整数 tick 分配**：每个 tick，每条链路最多传输 `bandwidth` 字节。
- **按 ID 轮转、按字节发**：同一链路上的就绪流按流 ID 升序轮转，每轮每流发 1 字节，直到该 tick 预算耗尽。
- **同刻新增下一轮参与**：tick `t` 加入的流从 tick `t+1` 起才参与分配。
- **多跳下一 tick 可发**：字节在 tick `t` 通过某链路后，tick `t+1` 才能在下一跳发送。
- **取消仅撤未发字节**：`cancel_flow` 在指定 tick 分配前生效，只撤销仍在源点、从未进入链路的字节；已在途字节继续传输直至送达。
- **字节守恒账**：对每条流恒有 `delivered + cancelled + in_flight + unsent == size`（`check_conservation` 校验）。
- **逐字节参考核验**：`ReferenceSimulator` 把每个字节显式放进 FIFO 队列逐跳搬运，测试要求主模拟器与其事件流（tick, flow, link, byte_index）完全一致。

## 构建与测试

```sh
cmake -B build
cmake --build build
ctest --test-dir build --output-on-failure
./build/netsim_cli   # 演示场景，打印事件与字节守恒账
```

## 结构

- `src/simulator.hpp/.cpp` — 主模拟器（计数式，O(流数) 每字节轮次）
- `src/reference.hpp/.cpp` — 字节显式参考实现（用于交叉核验）
- `src/main.cpp` — CLI 演示，输出事件日志与守恒账
- `tests/` — CTest 用例：基本轮转、多跳时序、取消语义、随机化参考比对
