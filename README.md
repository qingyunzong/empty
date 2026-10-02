# mold-scheduler — 注塑车间夜班离线排产

单台注塑机、夜班单班次离线排产。输入订单（交期/工时/能耗/模具）、模具更换时间矩阵与班次能耗预算，输出字典序目标 **(makespan, energy, tardiness)** 下的可行序列与全部并列最优解；不可行时给出最小不可行证据（IIS）与枚举哈希；资源受限时返回 `UNKNOWN`（绝不当 `UNSAT`）。

纯 Node.js 22 标准库，无第三方依赖；测试使用 `node:test`。

## 输入格式（JSON）

```json
{
  "jobs": [{ "id": "J0", "due": 9, "work": 1, "energy": 3, "mold": "B" }],
  "setup": [[0, 4], [2, 0]],
  "energyBudget": 23
}
```

- `jobs[].due/work/energy`：非负有限数；`mold`：字符串或数字；`id` 可省（默认 `J<下标>`），必须唯一。
- `setup[m][n]`：方阵，维度 = 订单中不同模具数（模具名排序后按下标对应），`setup[m][n]` 为从模具 m 换到 n 的时间，首件无换模时间。
- `energyBudget`：本班能耗上限，序列累计能耗超过即剪枝。

## 使用

```bash
node cli.js <input.json> [--max-states N] [--max-solutions N]
node --test          # 运行全部测试
```

退出码：`0` 正常求解（状态见输出 `status`）；`2` 输入非法（stderr 打 `ERR_SCHEMA`）；`64` 用法错误。

库接口：

- `src/solver.js` — `solveCanonical(instance, {maxStates, maxSolutions, reuse})`、`buildUnsatCertificate`、`verifyUnsatCertificate`、`buildSchedule`
- `src/scheduler.js` — `Scheduler`：`editJob` / `undo` / `redo` / `solve()`（增量重算）
- `src/bruteforce.js` — 独立暴力枚举（带安全定界剪枝），用于对照验证
- `src/validate.js` — 模式校验，抛 `SchemaError`（`code = ERR_SCHEMA`）

## 核心机制

- **状态空间探索 + 剪枝**：子集 DP（Held-Karp），状态 `(mask, last)` 上维护 (time, tardiness) 的 Pareto 标签（同一 mask 能耗恒定），支配标签即剪；部分能耗超预算即剪。相等标签合并前驱指针，**全部并列最优序列**都可回溯枚举。
- **增量重算**：`Scheduler` 保存上次 DP 表；编辑某订单后，仅重算 mask 含该订单下标的状态（`stats.incremental=true`，`statesComputed` 显著小于全量），其余子问题直接复用；枚举哈希与全量重算一致。
- **撤销/恢复**：编辑以命令对象进 undo 栈（新编辑清空 redo 栈），`undo()`/`redo()` 逐步还原到任一编辑点。
- **UNSAT 证书**：最小不可行核心（IIS）——核心子系统不可行，删去其中任一订单约束后子系统可行（逐一实际重解验证）；附输入哈希与失败枚举的 SHA-256 枚举哈希，`verifyUnsatCertificate` 可独立复验，篡改即失败。
- **UNKNOWN**：仅在超资源限制（`--max-states` 或 n > 22）时返回，不带 UNSAT 证书。

## 真实输出摘要（本仓库实测）

`node cli.js examples/instance.json`（12 订单、3 模具，退出码 0）：

```
status:     FEASIBLE
objective:  {"makespan":38,"energy":23,"tardiness":23}   # 字典序
tiedOptima: 192                    # 并列最优序列全部枚举
states:     4095                   # DP 状态数（2^12-1）
枚举哈希:    6ce01f116e7a0bc6e62032772cdfd6126f7cdcf80b65d2d50b35c00f1f88d627
schedule[0..2]: J9(B) 0→1, J8(B) 1→6, J4(B) 6→10, ...
```

对照验证：同一实例暴力枚举（`src/bruteforce.js`）得相同 objective 与全部 192 条并列解（见 `test/solver.test.js`）。

`node cli.js examples/unsat.json`（预算 1，退出码 0）：

```
status:     UNSAT
certificate.type: MINIMAL_INFEASIBLE_CORE
core:       [{"id":"J5","energy":4}]   coreEnergy 4 > budget 1
removals:   [{"removed":"J5","status":"FEASIBLE"}]   # 删除核心中任一约束即可行
minimal:    true
枚举哈希:    9c5d8cc833e77e99b7083fca95edd37a377aa20b9659ba6feff66390f6c5c8ec
```

非法 setup（2×2 矩阵对 1 种模具）：

```
$ node cli.js bad.json
ERR_SCHEMA: setup must have exactly 1 row(s) (one per distinct mold), got 2
退出码: 2
```

资源受限（`--max-states 1`）：`status: UNKNOWN`，`reason: state limit exceeded`，不附 UNSAT 证书。

增量与撤销（`test/scheduler.test.js` 实测）：改 `J3.due` 后增量求解仅重算约一半状态（2048/4095），objective、全部并列解与枚举哈希均与全量重算一致；连续两次 `undo()` 后实例与求解结果回到编辑前。

`node --test`：

```
# tests 3
# pass 3
# fail 0
```
