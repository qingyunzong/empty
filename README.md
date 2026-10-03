# dfa-migration-checker

设备科维护工单状态机迁移校验工具。用**积自动机（product automaton）**判定旧规程
与新规程两个 DFA 在所有 ≤ m 步操作序列上的**风险分级是否一致**；不一致时输出最短
**迁移见证（witness）**，把差异状态映射为**人工确认任务**，在预算内求**最小成本覆盖**；
预算不足时明确报 `INFEASIBLE`，绝不假装完成。

仅使用 Node.js 22 标准库与 `node:test`，单机离线运行，无任何第三方依赖。

## 运行

```bash
node --test                                  # 全部测试
node cli.js old.json new.json <budget> [m] [--plan plan.json]
node cli.js load [plan.json]                 # 载入并校验迁移计划
```

## 输入格式

`old.json` / `new.json` 均为完全 DFA（每个状态对每个符号都有转移）：

```json
{
  "states": ["idle", "check"],
  "alphabet": ["open", "ok"],
  "start": "idle",
  "transitions": { "idle": { "open": "check", "ok": "idle" }, "check": { "open": "check", "ok": "idle" } },
  "risk": { "idle": "low", "check": "medium" },
  "tasks": [{ "id": "confirm-check", "cost": 2, "covers": ["check"] }]
}
```

- `risk`：每个状态的风险分级（字符串或数字），两机比较的就是它。
- `tasks`（仅 `new.json` 需要）：人工确认任务。`covers` 引用**旧机**状态名；
  `cost` 必须是非负整数。
- `m`（可选第 4 个 CLI 参数）：操作序列长度上限。缺省为 `|Q_old| * |Q_new|`——
  最短区分串必然短于可达积状态数，因此该缺省值等价于无界等价判定。

## 输出

成功时 stdout 为 JSON，包含 `equal`、`witness`、`tasks`、`cost`、`planHash`：

```json
{ "equal": false, "witness": ["open", "ok"], "tasks": ["confirm-fix"], "cost": 3, "planHash": "..." }
```

- `equal=true` 时 `witness=null`、`tasks=[]`、`cost=0`。
- `witness`：最短区分串（符号数组），BFS 按层展开保证最短。
- `tasks`：最小成本覆盖的任务 id（升序）。并列最优的决胜规则：
  总成本更低 → 任务数更少 → 排序后 id 列表字典序更小（完全确定性）。
- `planHash`：对计划做键序规范化 JSON 后的 SHA-256。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（equal 或已给出预算内的迁移计划） |
| 7 | 输入错误：预算为负/非整数、状态缺失（start、转移目标、risk、covers 引用）、成本非整数等 |
| 8 | 预算不足或差异不可覆盖：stdout 输出 `INFEASIBLE`，**不写入 plan.json** |
| 2 | 计划载入被拒绝（文件缺失、JSON 截断、哈希不匹配） |
| 1 | 用法错误或其他未分类故障 |

## 迁移计划的保存 / 载入与恢复点

- 每次成功运行都会**原子保存**计划：先写 `plan.json.tmp.<pid>`，再 `rename(2)`
  覆盖 `plan.json`。**恢复点定义为 rename 原子替换成功之后**——在此之前崩溃，
  旧计划原样保留；在此之后，新计划已完整落盘，读者永远不会看到半截文件。
- `node cli.js load plan.json` 重新解析并重算 `planHash`：JSON 截断、被篡改或
  哈希不匹配都会被拒绝（退出码 2），且载入过程只读，旧计划保持不变。

## 机制

1. **等价判定**：在积自动机 `Q_old × Q_new` 上从 `(start_old, start_new)` 做 BFS，
   深度 ≤ m。风险分级不同的积状态即"坏状态"；首次（最浅层）遇到的坏状态对应的
   路径就是最短区分串。
2. **差异状态**：所有 ≤ m 步可达坏状态的旧机分量集合（排序去重），即需要人工
   确认覆盖的对象。
3. **最小覆盖**：对任务子集做带成本剪枝的精确 DFS 枚举，按上述决胜规则取最优；
   最小成本 > 预算或某差异状态不可覆盖 → `INFEASIBLE`（退出码 8）。

## 真实运行记录（examples/）

`examples/old.json` 与 `examples/new.json` 结构同构，但新规程把 `fix` 状态的风险
从 `high` 降为 `medium`。实际运行（2026-10-04，Node v22.22.1）：

```console
$ node cli.js examples/old.json examples/new.json 5 --plan /tmp/ex-plan.json
{
  "equal": false,
  "witness": [
    "open",
    "ok"
  ],
  "tasks": [
    "confirm-fix"
  ],
  "cost": 3,
  "planHash": "332e67a5547f8a134abb928c20ace9806f6517c29609ac016e5210a49ddde360"
}
（退出码 0）

$ node cli.js examples/old.json examples/new.json 2 --plan /tmp/ex-plan2.json
INFEASIBLE
（退出码 8，未写 plan 文件）

$ node cli.js examples/old.json examples/new.json -3
ERROR: invalid budget: -3 (must be a non-negative integer)
（退出码 7）

$ node cli.js load /tmp/ex-plan.json
{ "ok": true, "plan": { "version": 1, ..., "m": 16, "equal": false,
  "witness": ["open", "ok"], "diffStates": ["fix"],
  "tasks": ["confirm-fix"], "cost": 3 } }
（退出码 0）
```

## 测试

```console
$ node --test
# tests 3
# pass 3
# fail 0
```

3 个测试文件、18 个子测试全部通过，覆盖验收标准：

1. `test/equiv.test.js` — 重命名等价机 `equal=true`；差异仅在第 3 步时
   `witness` 长度为 3；并列最优任务集的确定性决胜；m≤6 时与暴力枚举所有
   操作序列（25 组随机 DFA × m=0..6）对照一致。
2. `test/plan.test.js` — 计划保存/载入往返、原子替换、半截 plan 拒绝且
   旧计划保持、篡改哈希拒绝。
3. `test/cli.test.js` — CLI 端到端：输出字段、退出码 7（负预算、状态缺失、
   成本非整数）、退出码 8（`INFEASIBLE` 且不写计划）、载入截断 plan 拒绝且
   旧计划可正常载入。

注：沙箱禁止派生子进程，CLI 测试通过 `cli.js` 导出的 `main()` 在进程内
捕获 stdio 完成，行为与真实命令行一致（已手动核对）。
