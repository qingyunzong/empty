# causal-event-analyzer

离线事件分析库与 CLI（Node.js 22 标准库 + `node:test`，无第三方依赖）。
针对存在延迟与乱序的设备日志，基于向量时钟与时间窗传播事件的先后关系，
对时钟无法判定的并发分支做带回溯的搜索，并校验安全规则。

## 事件模型

每条事件：`{ id, device, ts, vc, type }`

- `id`：非空字符串，全局唯一（重复 id 报错）。
- `device`：非空字符串，事件来源设备。
- `ts`：有限数值，设备本地时间戳。
- `vc`：向量时钟，对象映射 `设备名 -> 非负整数`（负数、小数、非对象均非法）。
- `type`：非空字符串，如 `RUN` / `STOP` / `RESET`。

## 求解模型

- **有限序号域**：事件被映射到序号域 `0..n-1`（`OrderState.index`），
  先后关系维护为 `n x n` 传递闭包矩阵；可行解是给每个事件分配唯一
  位置的排列（`result.positions`）。
- **先后关系传播**：
  - 向量时钟：`vc(a) < vc(b)`（分量 ≤ 且不等）则 `a -> b`；
  - 时间窗：`ts(a) + window <= ts(b)` 则 `a -> b`（`window` 为最大时钟偏移，默认 5）。
  两者矛盾时形成环，直接判为不可行并给出冲突链。
- **安全规则**：
  - `device-mutex`：同设备事件互斥，不得并列（并发），必须被排序；
  - `reset-before-run`：同设备上 `STOP -> RUN` 之间必须存在 `RESET`
    （传播器会在只剩一个候选 RESET 时强制其落入中间，无可候选时冲突）。
- **回溯搜索**：时钟与时间窗无法定序的同设备事件对构成搜索节点，
  按两种方向分支，每次分支尝试消耗 1 点预算，失败即沿 trail 撤销并回溯。
- **增量撤销**：所有传播都记录在带依赖（`deps` = 事件 id 集合）的 trail 上。
  `retractEvent` 找到最早依赖被删事件的 trail 项，撤销其后全部传播，
  重放无关项并重试此前成环的基边；`solve` 结束时把搜索节点恢复到
  入口检查点，因此重复求解结果一致。`correctEvent` = 原子 撤销+新增。
- **结果**：
  - `feasible`：`order`（唯一确定的因果顺序时 `unique: true`）、`positions`；
  - `infeasible`：`conflict` 为事件与规则组成的冲突链
    （`rule`、`events`、`chain`：带原因的先后路径）；
  - `unknown`：预算耗尽，`pending` 列出全部未决事件，
    `conflicts` 保留已探索分支中发现的冲突（不漏报）。

## CLI

```sh
node src/cli.js add '{"id":"e1","device":"A","ts":0,"vc":{"A":1},"type":"RUN"}'
node src/cli.js retract e1
node src/cli.js solve --budget 100
# 选项：--store <path>（默认 ./events.json）、--window <N>（默认 5）
```

退出码：

- `0`：成功（`solve` 的 feasible / infeasible / unknown 均为正常结果，JSON 输出到 stdout）；
- `1`：retract 未知 id 等其他运行错误；
- `2`：坏 JSON、重复 id、向量时钟非法、存储文件损坏、用法错误。

## 库 API

```js
import { Solver } from './src/solver.js';
const solver = new Solver({ window: 5 });
solver.addEvent({ id: 'e1', device: 'A', ts: 0, vc: { A: 1 }, type: 'RUN' });
solver.correctEvent({ id: 'e1', ... }); // 更正
solver.retractEvent('e1');              // 撤销
solver.solve({ budget: 100 });          // => { status, ... }
```

## 测试

`npm test`（即 `node --test`）。验收标准对应：

1. `test/linearize.test.js` — 可线性化日志输出唯一因果顺序，
   并由独立重建 DAG、枚举全部拓扑序核对（恰好 1 个且与求解结果一致）。
2. `test/retract.test.js` — 错误事件触发 `reset-before-run` 冲突链
   （含事件与规则）；撤销后冲突消失，增量撤销只回滚依赖传播，
   重复求解结果完全一致。
3. `test/budget.test.js` — 两个并发历史 + 预算不足时返回 `unknown`，
   `pending` 列出全部 4 个未决事件，已发现冲突保留在 `conflicts` 中不漏报。

### 真实测试结果（2026-10-03，node v22.22.1）

```
$ node --test
1..5
# tests 5        # 5 个测试文件，共 19 个子测试
# pass 5
# fail 0
# duration_ms 33101
```

逐文件（`node --test test/<file>`）：

| 文件 | 子测试数 | 结果 |
| --- | --- | --- |
| test/validate.test.js | 4 | pass |
| test/linearize.test.js | 1 | pass |
| test/retract.test.js | 3 | pass |
| test/budget.test.js | 3 | pass |
| test/cli.test.js | 8 | pass |

注：本沙箱中 spawnSync 无法捕获子 node 进程的 stdout 管道，
CLI 测试通过 bash 重定向到临时文件读取输出（见 `test/cli.test.js` 注释）。
