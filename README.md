# temporal-monitor

有限时序条件监测库（TypeScript + Node.js 内置库，零运行时依赖）。
编译形如 **“A 后 d tick 内出现 B，且期间无 C”** 的时序条件，逐 tick 驱动实例机，
输出匹配/违例证据，支持逐 tick 实例枚举对照与快照续行。

## 语义约定

- **多实例**：每个 `A`（trigger）输入生成一个独立实例，ID 从 1 单调递增。
- **窗口**：实例期限 `deadline = 触发 tick + window`；`B` 在 deadline 当 tick 到达仍算匹配。
- **同 tick 输入先于超时**：同一 tick 内先由 `input()` 处理全部输入，`endTick()`
  时才做超时判定——因此 deadline 当 tick 的 `B` 优先匹配，不会误判超时。
- **单事件处理顺序**：先 forbidden 判定（所有活跃实例违例），再 expect 匹配，
  最后 trigger 生成新实例。
- **匹配策略**：`oldest`（默认）一个 `B` 只满足最老活跃实例；`all` 满足全部活跃实例。
- **取消**：`cancel(id)` 仅注销对应 ID 的活跃实例，其余实例不受影响；被取消者不产生证据。

## API 概览

```ts
import { compile, Monitor } from './src/monitor';

const m = compile({ trigger: 'A', expect: 'B', forbid: ['C'], window: 3 });
m.input('A');            // tick 0：生成实例 #1（deadline=3）
m.endTick();             // 结束 tick 0，做超时判定，前进到 tick 1
m.input('B');            // tick 1：匹配实例 #1
m.endTick();
m.getOutcomes();         // => [{ kind:'match', instanceId:1, triggerTick:0, matchedTick:1, latency:1 }]
m.getTrace();            // 逐 tick 枚举：inputs / evidence / cancelled / activeAfter
```

- `input(type, payload?)`：当前 tick 输入事件，可多次调用。
- `endTick(steps = 1)`：超时判定 → 固化本 tick 枚举记录 → 前进 tick。
- `cancel(id): boolean`：注销指定 ID 的活跃实例。
- `getActive()` / `getOutcomes()` / `getTrace()`：活跃实例、证据流、逐 tick 枚举。
- `snapshot()` / `snapshotJSON()`：可 JSON 序列化的全量状态（含未 endTick 的 pending 输入）。
- `Monitor.restore(snap)` / `Monitor.restoreJSON(json)`：从快照续行，ID 计数延续。

## 证据结构

- 匹配：`{ kind:'match', instanceId, triggerTick, matchedTick, latency }`
- 超时违例：`{ kind:'violation', reason:'timeout', instanceId, triggerTick, deadline, detectedTick }`
- 禁止事件违例：`{ kind:'violation', reason:'forbidden', instanceId, triggerTick, forbiddenEvent:{tick,type,payload} }`

## 构建与测试

```sh
npm run build   # tsc 编译到 dist/（需要全局或本地 tsc）
npm test        # 编译并运行 node:test 测试
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），npm 9.2.0。

`npm test`（`tsc -p tsconfig.json && node --test dist/test/*.test.js`）退出码 0：

```
# tests 1
# pass 1
# fail 0
```

测试文件内 14 个用例逐条结果（`node dist/test/monitor.test.js`）：

```
ok 1 - 匹配：窗口内 B 到达，输出匹配证据（含 latency）
ok 2 - 同 tick 输入先于超时：B 恰在 deadline 当 tick 到达仍匹配
ok 3 - 同 tick 输入先于超时：A 与 B 同 tick，latency 为 0
ok 4 - 违例：超时，证据含 deadline 与 detectedTick
ok 5 - 违例：窗口内出现 C，证据含禁止事件 payload；之后 B 不再匹配
ok 6 - 多个 A 各有实例：B 默认只满足最老实例，另一个独立超时
ok 7 - matchPolicy=all：一个 B 满足全部活跃实例
ok 8 - 取消只销对应 ID：其余实例照常运行，被取消者无证据
ok 9 - 逐 tick 实例枚举：trace 记录输入、证据与活跃集合
ok 10 - 快照续行：恢复后运行结果与不中断运行完全一致
ok 11 - 快照：恢复后 ID 计数延续，不产生冲突
ok 12 - 无活跃实例时 B 被忽略，不产生证据
ok 13 - 非法条件与非法快照被拒绝
ok 14 - 证据对象不被外部修改影响（防御性拷贝）
# tests 14
# pass 14
# fail 0
```
