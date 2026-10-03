# starcats — 可解释、可重放的增量星表维护

夜间观测不中断地维护星表：读入 JSONL 事件流（新测光、撤回、更正、检查点、
回滚、求解），增量维护每颗星的有限域，并按需用「有限域传播 + 回溯」求解
当前星表。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 运行

```sh
node src/cli.js events.jsonl                 # 从文件读事件
cat events.jsonl | node src/cli.js           # 从 stdin 读事件
node src/cli.js events.jsonl --coords 8 --mags 6 --creds 4 --capacity 4
node --test                                  # 运行全部测试
```

## 事件（每行一个 JSON 对象）

| type | 字段 | 语义 |
| --- | --- | --- |
| `add_obs` | `id, star, night, coord, mag, cred` | 新增一条测光 |
| `retract_obs` | `id` | 撤回该 id 最新一条测光（LIFO） |
| `correct_obs` | `id` + `star/night/coord/mag/cred` 至少其一 | 更正最新一条测光 |
| `checkpoint` | `name` | 压入一个检查点 |
| `undo_to` | `name` | 恢复到栈顶检查点（名字必须匹配栈顶） |
| `solve` | 可选 `prop_budget, back_budget` | 求解当前星表 |

`coord/mag/cred` 是**有限域 bin**：可以是一个整数（精确），也可以是整数
数组（候选 bin 集合，表示测位/测光不确定度）。星的域 = 其全部活跃观测
的 bin 集合的交集。`night` 为非负整数。

## 约束

- `unique_pk`：同一 id 至多一条活跃观测（重复 add 不拒绝，而是记入冲突，
  由 solve 判定）。
- `time_order`：同一颗星的活跃观测按到达顺序，night 必须严格递增。
- `exclusive_attribution`：不同星不得占据同一坐标 bin（alldiff）。
- `night_capacity`：每晚活跃观测数 ≤ `capacity`。
- `attribution_consistency`：同一颗星的观测必须在 coord/mag/cred 上相容
  （任何域不得为空）。

## 增量与重放

- `add_obs` 只做单星域交集收缩；`retract_obs`/`correct_obs` 只重算被触及
  的星（绝不全量重算）。更正的连锁重分配通过 alldiff 工作清单传播，并在
  ack 的 `effects.cascade` 中输出；冲突解释在 `effects.conflicts` 中给出
  （约束名 + 人类可读消息）。
- 检查点是栈。`undo_to(name)` 仅当 `name` 等于栈顶时合法：越级回滚报
  `UNDO_SKIP_FORBIDDEN`，未知检查点报 `UNDO_UNKNOWN_CHECKPOINT`，失败的
  undo 不改变状态（停留在最近一致点）。恢复会截断有效事件日志，因此
  「撤销后继续求解」与「从头重放存活前缀」逐字节一致（验收 2 有测试）。

## 求解与预算

- 传播：坐标 alldiff 的单例（failed-set）消除，每次值删除计 1 个传播步。
- 回溯：最小域优先、值升序分支，每个分支节点计 1 个回溯节点。
- 两类预算分别扣减；任一耗尽返回 `PENDING`（`reason: BUDGET_EXCEEDED`，
  `exhausted: propagation|backtracking`），并在 `facts` 中保留已传播事实。
  **PENDING 严禁等同 UNSAT**。
- `SAT` 返回 `model`；`UNSAT` 返回删除法最小化的核心：
  `core.events`（有效事件日志下标）、`core.obs`、`core.constraints`。

## 退出码

| code | 含义 |
| --- | --- |
| 0 | 全部 solve 为 SAT（或无 solve） |
| 2 | 输入非法（JSON 错误、字段非法、未知 id、非法 undo 等），输出 JSON error |
| 3 | 存在 UNSAT |
| 4 | 存在 PENDING（优先于 3，因为最终答案未知） |

## 输出

每个输入事件对应一行 JSON：状态变更事件输出 `ack`（含 `log_index` 与
`effects`），`solve` 输出 `solve_result`，错误输出
`{"seq", "type":"error", "error":{"code","message"}}` 并以 exit=2 终止。

## 文件

- `src/solver.js` — 有限域传播 + 回溯、预算、UNSAT 核心最小化
- `src/catalog.js` — 增量星表状态、事件应用、检查点栈
- `src/enumerator.js` — 独立暴力枚举器（验收 3 的逐状态对照）
- `src/cli.js` — 命令行入口
- `test/` — 单元测试、四条验收测试、CLI 退出码测试
