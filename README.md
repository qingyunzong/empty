# CNC 产线离线维护规划器

离线安排刀具更换（`changeTool`）与量具校准（`calibrate`），目标**最小化停机时间**，
同时不违反刀具剩余寿命、校准到期（calDue）与每周维护预算。求解器输出最优 plan
（含全部并列最优解）或**最小不可行证书**；不存在 `UNKNOWN` 状态，UNSAT 均由完备
搜索得出，不会被 UNKNOWN 冒充。

仅依赖 Node.js 22 标准库，测试使用 `node:test`。

## 模型

状态：`{ toolWear, calDue, budget, opIndex, downtime }`，`pendingOps = ops.slice(opIndex)`。

| 动作 | 前置条件 | 效果 | 成本 |
| --- | --- | --- | --- |
| `run(op)` | 队首工序；`toolWear + op.wear <= toolLife`；`op.duration <= calDue` | 磨损累加、calDue 扣减、工序出队 | 停机 0 |
| `changeTool` | `budget >= costs.changeTool.cost` | `toolWear = 0` | 停机 `+time`，预算 `-cost` |
| `calibrate` | `budget >= costs.calibrate.cost` | `calDue = calInterval` | 停机 `+time`，预算 `-cost` |

无效果维护动作（磨损为 0 换刀 / calDue 已满时校准）被任何包含它的计划严格支配，
从搜索动作空间剔除；最优并列解集不受影响。

## 并列最优

主目标为停机最小。所有达到最小停机的计划**全部保留**，输出按
`(停机升序, 预算余量降序, 动作序列字典序)` 排序（`src/domain.js` 的 `comparePlans`）。

## 撤销与增量失效

`Planner` 支持交互式探索：`apply(action)` / `undo()` / `snapshot()` / `Planner.restore()`。
后缀最优解以状态为键记忆化（与到达路径无关），`undo()` 只弹出最近计划步并恢复状态，
未受影响分支的缓存继续命中，重新 `solve()` 仅重算受影响分支
（由返回值的 `stats.computed` / `stats.cacheHits` 可观测）。

## UNSAT 证书

`solve()` 返回 UNSAT 时附 `certificate`（`src/certificate.js`）：

- `exhaustive: true` —— 完备搜索结论；
- `relaxations`：对每道工序给出 `removeCalDueConstraint`（删去该工序的到期约束）
  与 `addBudget: 1`（增加一单位预算）的单点松弛结果，`feasible: true` 者附目击计划；
- `verifyCertificate(problem, certificate)` 独立复验：重解原问题确认 UNSAT、
  重解每个松弛项核对可行标志、重放目击计划核对停机值。

## CLI

```bash
node cli.js plan.json        # SAT -> 打印 plans；UNSAT -> 打印 certificate
```

退出码：`0` 正常求解（含 UNSAT）；`1` 域错误（`ERR_DOMAIN`，如预算为负、寿命 NaN）；
`2` 参数错误。问题格式见 `examples/sat.json`。

## 测试

```bash
node --test
```

真实结果（Node v22.22.1）：2 个测试文件、9 个用例全部通过
（`test/planner.test.js` 5 项、`test/cli.test.js` 4 项）：

- 验收 1：8 工序与独立全枚举对照，最优停机 10，11 个并列解集合与排序完全一致；
- 验收 2：calDue 冲突返回证书（删 c2/c3 到期约束或预算 +1 即可行），复验通过；
- 验收 3：撤销三步后与 `Planner.restore(snapshot)` 状态及求解结果一致，且缓存命中 > 0；
- 验收 4：预算为负、toolLife/磨损为 NaN 等均抛 `ERR_DOMAIN`；
- 前置条件违反抛 `ERR_PRECONDITION`；CLI 的 SAT / UNSAT / ERR_DOMAIN / 缺参路径均覆盖。
