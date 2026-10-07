# probe-sim

探测模拟库：为每个节点维护**心跳序号**、**探测代际**与**疑似期限**，模拟随机延迟导致的回包重排，输出节点的存活 / 疑似 / 失效状态及判定依据。

## 核心规则

- **心跳序号（heartbeatSeq）**：只被有效回包推进，单调递增。
- **探测代际（probeGeneration）**：每次重新探测 +1，使旧代际回包自动失效。
- **疑似期限（suspicionDeadline）**：发出探测后 `suspicionTimeout` 个 tick 无有效回包 → 疑似；`failureTimeout` 个 tick → 失效。
- **旧回包不能清新疑似**：代际或序号与当前未决探测不匹配的回包一律拒绝，不改变状态。
- **同刻有效回包先于超时**：`advance(now, acks)` 在同一 tick 内先应用全部回包，再判定超时。
- **failed 为终态**：之后的回包不再改变状态。

## 使用

```ts
import { ProbeMonitor, SimulatedNetwork, Simulation, mulberry32 } from "./src";

const monitor = new ProbeMonitor({ suspicionTimeout: 3, failureTimeout: 8 });
monitor.registerNode("n1", 0);
const network = new SimulatedNetwork(mulberry32(42), 6); // 可复现的随机延迟
const sim = new Simulation(monitor, network);

sim.probe("n1", 0);        // 发出探测（seq=1, gen=1），回包被随机延迟
sim.advanceTo(3);          // 推进到 t=3：同刻回包先处理，再判超时
console.log(monitor.getStatus("n1"));
// { id, state: "alive" | "suspected" | "failed", reason, heartbeatSeq,
//   probeGeneration, suspicionDeadline, failureDeadline }
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行
```

测试覆盖：旧回包（旧代际 / 旧序号 / 重复）不能清新疑似、同刻有效回包先于超时、随机延迟重排下监控器正确收敛、单节点场景与独立参考模型逐 tick 交叉核验（多种子、含丢包）。
