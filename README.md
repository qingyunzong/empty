# margin-call-engine

离线单机风控追缴调度库 + CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 账户：`{ id, priority, liquidationLine, deadlineSlot, cash, position }`
- 权益：`equity = cash + position * price`；缺口：`gap = max(0, liquidationLine - equity)`；`gap > 0` 产生追缴任务。
- 行情事件：`{ accountId, price, version }`；撤销事件：`{ op: "undo", accountId, version }`。

## 核心机制

- **约束资源分配**：追缴任务为单位任务，槽位 `1..slots`，每槽容量 `slotCapacity`，任务必须排在 `deadlineSlot` 之前。
  调度按排名贪心（优先级降序 → 缺口降序 → 强平距离升序 → 账户 id 升序），每个任务放到不超过截止槽的**最迟空槽**
  （带截止的单位任务调度最优贪心）。容量不足时高排名任务占槽，低排名任务被拒并记录 `preemptedBy`。
- **增量更正**：每个行情/撤销事件只重算受影响账户的状态（`RiskEngine.recompute` 仅触及单账户）。
- **快照撤销恢复**：每账户保留有效版本历史 `version -> price`。撤销当前头版本时回滚到最高有效低版本，
  重放该账户的追缴计算，并记录 `rolledBack: [{ accountId, fromVersion, toVersion }]`。

## 并发/版本规则

- 同一账户 `version <= 当前头版本` 的行情被拒绝（`STALE_TICK`），低版本不得覆盖高版本。
- 撤销不存在的版本报 `UNDO_GAP`；tick 使权益为负报 `NEGATIVE_EQUITY`（该 tick 不生效）；
  无法排入槽位报 `NO_CAPACITY`。

## 确定性

`proof.seed` 为输入（accounts + events + config）规范化 JSON 的 SHA-256 前 16 位十六进制；
`proof.scheduleHash` 为 `{ seed, calls, rolledBack, errors }` 的 SHA-256。相同输入必然得到相同输出。

## 使用

```bash
node src/cli.js examples/ticks.json examples/accounts.json [--slots N] [--slot-capacity C]
node --test
```

输出：`{ calls, rolledBack, errors, proof }`。

库 API：

```js
import { RiskEngine, runEngine } from './src/engine.js';
import { fullRecompute } from './src/full-recompute.js'; // 独立全量重算对照

const result = runEngine(accounts, events, { slots: 2, slotCapacity: 1 });
```

## 测试

`test/engine.test.js` 覆盖：乱序行情拒绝、撤销高版本恢复低版本并重放追缴、槽满时高缺口抢占低缺口、
优先级/平局规则、截止约束、确定性 seed 与 scheduleHash，以及 300 个 n≤8 随机场景下
增量引擎与独立全量重算（`src/full-recompute.js`）的 calls/rolledBack/errors/scheduleHash 全等对照。
`test/cli.test.js` 覆盖 CLI 输入输出、flag 覆盖与用法错误。
