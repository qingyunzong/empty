# causal-event-analyzer

离线事件分析库 + CLI。针对存在延迟与乱序的设备日志，把事件映射到有限
序号域（线性化位置 0..n-1），按向量时钟与时间窗传播先后关系，对时钟
无法判定的并发分支做回溯搜索，并支持事件的增量新增、更正与撤销。

仅依赖 Node.js 22 标准库；测试使用 `node:test`。

## 事件模型

```json
{ "id": "e1", "device": "d1", "ts": 1696000000000, "vc": { "d1": 1 }, "type": "RUN" }
```

- `vc` 必须是「设备 → 非负安全整数」的对象，否则视为非法（退出码 2）。
- 更正事件 = `retract` 旧事件后 `add` 新事件。

## 约束与规则

1. **向量时钟**：`vc(a) < vc(b)` ⇒ `a ≺ b`（硬先后边）。
2. **时间窗**：`ts(b) - ts(a) > maxSkewMs`（默认 30000ms）⇒ `a ≺ b`。
3. **因果链安全规则**：每台设备运行状态机
   `ready --RUN--> running --STOP--> stopped --RESET--> ready`，
   即 STOP 后必须 RESET 才能再次 RUN；非法迁移剪掉对应分支。
4. **同设备互斥**：同设备事件在线性化中必须严格有序，不允许并列；
   具体顺序由状态机约束判定。

规则 1、2 由传播引擎（`src/engine.js`）推导为先后边并做传递闭包；
规则 3、4 在回溯搜索（`src/solver.js`）中按位置逐个放置事件时检查。

## 增量与撤销

- `engine.addEvent` 只对新事件与既有事件推导新边；
  `engine.retractEvent` 精确删除由被撤销事件所证明的全部事实。
- `engine.begin() / addDecisionEdge() / rollback(mark)` 提供 trail，
  搜索层可投机传播并无偿恢复到检查点（搜索节点状态随之还原）。
- 撤销后重新求解的结果与从未加入该事件时完全一致（测试保证可重复）。

## 求解结果

| status       | 含义           | 携带信息 |
|--------------|----------------|----------|
| `sat`        | 找到合法线性化 | `order`、`positions`、`unique`（是否唯一因果顺序） |
| `infeasible` | 无可行线性化   | `conflict`：由事件 id 与规则名组成的冲突链 |
| `unknown`    | 预算耗尽       | `pending`：尚未判定的并发事件 |

传播阶段发现的硬冲突（如向量时钟与时间窗构成的环）在任何预算下都会
报告，不会被 `unknown` 掩盖。

## CLI

```sh
node src/cli.js add event.json [--db PATH]     # 或 add - 从 stdin 读
node src/cli.js retract <id> [--db PATH]
node src/cli.js solve --budget N [--max-skew-ms M] [--db PATH]
```

退出码：`0` sat，`1` infeasible，`2` 输入错误（坏 JSON / 重复 id /
向量时钟非法 / 未知 id），`3` unknown（预算耗尽）。
状态文件默认 `.cea-events.json`。

## 测试

```sh
node --test
```

真实结果（Node v22.22.1，2026-10-04）：

```
ok 1 - test/budget.test.js
ok 2 - test/cli.test.js
ok 3 - test/linearizable.test.js
ok 4 - test/retract.test.js
ok 5 - test/validation.test.js
# tests 5
# pass 5
# fail 0
# duration_ms 28555.754363
```

逐文件子测试（共 21 个，全部通过）：

| 文件 | 子测试 | 覆盖验收标准 |
|------|--------|--------------|
| `test/linearizable.test.js` | 3/3 | 验收 1：唯一因果顺序 + 独立枚举拓扑序核对 |
| `test/retract.test.js`      | 4/4 | 验收 2：撤销后冲突消失、状态恢复且结果可重复 |
| `test/budget.test.js`       | 5/5 | 验收 3：并发历史 + 预算不足为 unknown，硬冲突不漏报 |
| `test/validation.test.js`   | 7/7 | 坏 JSON / 重复 id / 非法向量时钟 → 退出码 2 |
| `test/cli.test.js`          | 2/2 | CLI add/retract/solve 端到端与退出码 0/1/2/3 |
