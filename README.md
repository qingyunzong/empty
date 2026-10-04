# finite-timing-monitor

零依赖 TypeScript 时序监测库（仅用 Node.js 内置模块）：把有限时序条件（如「A 之后 d tick 内出现 B，且期间无 C」）编译为逐 tick 驱动的监测器，支持多实例、按 ID 取消、同 tick 输入优先于超时、匹配/违例证据输出、逐 tick 实例枚举对照，以及快照续行。

## 条件模型

```ts
interface TimingConditionSpec {
  name?: string;            // 缺省为 trigger 名
  trigger: string;          // 触发事件 "A"：每次出现都生成一个新实例
  windowTicks: number;      // 窗口长度 d（>= 1 的整数）
  require?: string[];       // 窗口内必须各出现至少一次的事件（如 ["B"]）
  forbid?: string[];        // 窗口内不得出现的事件（如 ["C"]）
}
```

`compileCondition(spec)` 校验并冻结条件（require/forbid 重叠、窗口非正整数等抛错）；`monitorFor(specOrSpecs)` 一步编译并创建监测器；多个条件可共用一个 `Monitor` 与同一事件流。

## 语义约定

- 窗口：实例在 tick `t` 由触发事件生成，窗口为 `(t, t+d]`，截止 tick 为 `t+d`。与触发事件同 tick 的事件不属于窗口。
- 实例：每个触发事件生成一个独立实例（唯一自增 ID），各自记录已见必需事件。同一事件作用于所有存活实例（两个 A 实例都能吃到同一个 B）。
- 同 tick 顺序：每个 `step(events)` 内——先应用全部输入事件（禁例事件立即判违例），再生成新实例，最后处理本 tick 到期的超时。因此在截止 tick 到达的 B 仍然有效，在截止 tick 到达的 C 也仍然违例。
- 取消：`cancel(id)` 只删除对应 ID 的实例，其余实例（包括同条件实例）不受影响。
- 判定：窗口内出现禁例事件 → 立即输出 `violation / forbidden-event`（证据含事件名与所在 tick）；到期时必需事件齐全且无禁例 → 输出 `match`（证据含每个必需事件首次出现的 tick）；到期时必需事件缺失 → 输出 `violation / missing-required`（证据含缺失事件列表）。

## API 摘要

```ts
const mon = monitorFor({ trigger: "A", windowTicks: 3, require: ["B"], forbid: ["C"] });
mon.step(["A"]);        // 推进 1 tick 并喂入本 tick 事件，返回本 tick 产生的 Outcome[]
mon.advance(2);         // 无输入推进 n tick
mon.cancel(1);          // 按 ID 取消实例，返回 boolean
mon.enumerate();        // 逐 tick 实例枚举：id/条件/出生 tick/截止/剩余/已见必需事件
mon.outcomes;           // 累计的全部匹配/违例证据
const snap = mon.serialize();           // JSON 字符串快照
const mon2 = Monitor.deserialize(snap); // 续行：tick、实例、ID 计数、证据日志完整恢复
```

## 构建与测试

```sh
npm run build   # tsc -p tsconfig.json（编译到 dist/）
npm test        # 编译后用 node --test 运行 dist/test/*.test.js
```

环境要求：Node.js（开发使用 v22.22.1）与 TypeScript 编译器（开发使用 tsc 7.0.2）。无 npm 依赖；`test/node-shims.d.ts` 为 `node:test` / `node:assert/strict` 提供最小类型声明。

## 实际测试结果

2026-10-05 在本仓库环境（Node v22.22.1，tsc 7.0.2）执行 `npm test`，退出码 0。`node dist/test/monitor.test.js` 的逐条结果：

```
ok 1 - compile: validates specs and freezes the result
ok 2 - match: B within d ticks after A and no C produces match evidence at the deadline
ok 3 - violation: missing required event is reported at the deadline with evidence
ok 4 - violation: forbidden C closes the instance immediately at C's tick
ok 5 - multiple A events each spawn their own instance with independent outcomes
ok 6 - cancel removes only the instance with the matching id
ok 7 - same-tick inputs are processed before timeouts (B on the deadline tick counts)
ok 8 - same-tick forbidden event beats the timeout (C on the deadline tick violates)
ok 9 - events on the trigger tick itself are outside the window (t, t+d]
ok 10 - per-tick instance enumeration matches the expected table
ok 11 - snapshot/resume: a restored monitor continues identically to the original
ok 12 - snapshot taken after cancel resumes without the cancelled instance
ok 13 - multiple conditions share one monitor and one event stream
ok 14 - monitor rejects invalid advance counts and bad snapshots
ok 15 - compiled conditions can be reused across monitors
# tests 15
# pass 15
# fail 0
```
