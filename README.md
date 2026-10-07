# probe-detector-sim

TypeScript 探测/心跳失效检测模拟库。检测器为被监控节点维护：

- **心跳序号**（heartbeat）：只接受严格递增的序号，旧心跳回包不能刷新节点。
- **探测代际**（generation）：每轮探测递增，跨代旧回包不能清新疑似。
- **疑似期限**（suspicion deadline）：`SUSPECT` 后到期未收到有效回包即判 `DEAD`。

## 规则

- 有效回包 = 当前代际 + 更高心跳序号；可清除疑似并恢复 `ALIVE`。
- 同一 tick 内先投递回包、再评估超时（同刻有效回包先于超时）。
- `DEAD` 为终态，后续回包一律忽略。
- 每次状态迁移与被忽略的回包都记录依据（reason）。

## 结构

- `src/detector.ts` — 检测器核心规则（纯事件应用，无调度）。
- `src/simulator.ts` — 离散事件模拟器，随机延迟/丢包重排回包（种子化 RNG）。
- `src/reference.ts` — 单节点参考模型，用于交叉核验模拟器轨迹。
- `test/` — 规则单测、随机重排不变量、模拟器 vs 参考模型一致性。

## 运行

```sh
npm test   # tsc 编译 + node --test
```
