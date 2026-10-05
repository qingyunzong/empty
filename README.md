# line-sim 产线模拟库

TypeScript + Node.js 内置库（`node:test` / `node:assert`）实现的离散 tick 产线模拟。

## 核心语义

- **消耗与产出**：机器开工时从输入仓消耗 `recipe.inputs`，加工 `duration` 个 tick 后完工，产出 `recipe.outputs`。
- **持成品阻塞**：输出仓容量不足时，机器持有成品进入阻塞，不释放机器、不能开工新任务；仓内腾出空间后的下一个 tick 自动入库恢复。
- **同 tick 顺序**：`故障恢复 -> 完工 -> 入库 -> 开工`。完工的成品同 tick 即可入库，入库后空闲的机器同 tick 即可开工。
- **故障暂停续行**：`injectFault(id, n)` 令机器停机 n 个 tick，加工进度冻结不丢失，修复后从暂停处续行；阻塞中的机器故障期间也无法入库。
- **事件与快照**：每个 tick 产生事件流（`start/complete/store/blocked/fault/repaired/add/remove`）与全量状态快照。
- **物料守恒核对**：逐 tick 校验分物料台账
  `物理总量 == 初始库存 + 外部投入 - 外部取出 - 已完工消耗 + 已完工产出`，
  物理总量含仓库库存、机在制品（wip）、机器持有的成品（held）。

## 使用

```ts
import { Simulation } from "./src/sim.js";

const sim = new Simulation({
  buffers: [
    { id: "raw", capacity: 100, initial: { iron: 10 } },
    { id: "product", capacity: 3 },
  ],
  machines: [
    {
      id: "press",
      recipe: { inputs: { iron: 2 }, outputs: { plate: 1 }, duration: 2 },
      inputBuffer: "raw",
      outputBuffer: "product",
    },
  ],
});

sim.injectFault("press", 2);        // 注入故障
const report = sim.step();          // 推进一个 tick
console.log(report.events);         // 本 tick 事件
console.log(report.snapshot);       // 本 tick 快照
console.log(report.conservation.ok); // 物料守恒核对
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`：

```
ok 1 - 机器消耗输入并按工期产出
ok 2 - 同 tick 顺序为完工 -> 入库 -> 开工
ok 3 - 输出仓满则持成品阻塞，机器不释放、不提前开工
ok 4 - 故障在加工中暂停，修复后续行，进度不丢失
ok 5 - 故障发生在持成品阻塞期间，修复后才能入库
ok 6 - 逐 tick 物料守恒：多机产线含投料、取料、故障、阻塞
ok 7 - 事件快照可还原每 tick 的库存与机器状态
ok 8 - 输入不足时机器保持空闲
# tests 8
# pass 8
# fail 0
```

另做反例验证：篡改内部库存后 `checkConservation()` 返回
`ok: false`（expected y=2, actual y=99），守恒核对能有效发现物料凭空产生。
