# mold-sched — 注塑车间离散时隙排产（库 + CLI）

仅使用 Node.js 22 标准库，离线运行。求解器为精确分支定界（指数级，面向小规模工单），
输出带有可逐项核验的证书；测试基于 `node:test`。

## 模型约定

- 时间为整数时隙 `t = 0, 1, 2, …`。生产与换模只能发生在班次窗口内；班次之外的时隙只能空闲。
- 每个班次的 `quotas` 给出**该班次内、全机台合计**的各产品族产能配额（单位：时隙）。
  未在 `quotas` 中出现的产品族在该班次配额为 0。
- 工单字段：`release`（释放时刻）、`duration`（时长，时隙数）、`deadline`（截止期）、
  `family`（产品族）、`priority`（`low|normal|high|critical` 或整数 0–3）、
  `machines`（可兼容机台）。可选顶层字段 `now`（默认 0）表示排产起始时刻。
- 机台对某个未完成工单保持“已装模”状态。已装模且可运行的工单只能被 **critical**
  工单抢占（被抢占者优先级必须更低）；抢占只能发生在整数时隙（模型本身即离散），
  每次抢占在被抢占者之后、抢占者首段之前产生 **1 个换模时隙**；**每个工单最多被抢占 2 次**。
  若已装模工单因班次间隙或配额耗尽而无法运行，机台可空闲或自由切换（不计抢占、不产生换模）。
- 工单的不同生产段可以位于不同的兼容机台（迁移），同一时隙同一工单只能在一台机台上运行。
- 目标：最小化**总拖期** `Σ max(0, completion - deadline)`；并列时按工单编号字典序
  比较各工单拖期向量（id 升序），取字典序最小者。
- 不可行判定：
  - `deadline < release` 的工单永远不可能按期 → 不可行并给出原因；
  - 某产品族全部班次配额之和 < 该族工单总时长 → 不可行并给出原因；
  - 否则在规划视界（最后一个班次结束）内做穷举搜索，找不到完整方案则不可行。
  - **尚未到释放时刻的工单不是不可满足**：它们会被排到释放之后。

## 输入格式（JSON）

```json
{
  "now": 0,
  "machines": ["M1", "M2"],
  "shifts": [
    { "id": "S1", "start": 0, "end": 8, "quotas": { "A": 6, "B": 4 } }
  ],
  "orders": [
    { "id": "J1", "release": 0, "duration": 4, "deadline": 8,
      "family": "A", "priority": "critical", "machines": ["M1", "M2"] }
  ]
}
```

## CLI 用法

```bash
node bin/mold-sched.js solve  <instance.json|-> [--out solution.json]
node bin/mold-sched.js verify <instance.json> <solution.json>
node bin/mold-sched.js <instance.json>            # 等同于 solve
```

- `solve` 输出：机台时间片（production / changeover / idle）、班次配额用量、
  每个工单的抢占次数与拖期、总拖期，以及 `certificate`（逐项核验结果）。
- 无可行方案时输出 `{"status": "infeasible", "reasons": [...]}`，退出码仍为 0。
- 非法输入（JSON  malformed、缺字段、类型错误、时长 < 1、班次重叠、未知机台等）
  退出码为 1，错误信息写入 stderr。
- `verify` 独立重算证书：全部通过退出码 0，任一项失败退出码 1。

## 库 API

```js
import { parseInstance, solve, verifySolution } from './src/index.js';

const inst = parseInstance(rawJson);   // 非法输入抛 InstanceError
const sol = solve(inst);               // { status: 'optimal' | 'infeasible', ... }
const cert = verifySolution(inst, sol); // { ok, checks: [{ id, ok, detail }] }
```

## 证书核验项（逐项）

- `shape` / `orders-covered` / `machines-covered`：解的结构与覆盖完整性；
- `order:<id>:pieces` / `:duration` / `:preemptions` / `:tardiness`：
  每段在兼容机台上、不早于释放时刻、落在班次内、总时长等于工单时长、
  抢占次数与重算一致且 ≤ 2、完成时刻与拖期重算一致；
- `machine:<id>:timeline`：时间片有序不重叠、引用合法；
- `no-simultaneous-machines`：同一工单同一时隙只在一台机台；
- `changeovers-justified` / `changeover-count`：每个换模时隙都对应一次合法的
  critical 抢占，且换模总数等于抢占总数；
- `switch-legality`：按时间轴重放，未完成已装模工单只能经抢占被替换，
  或在其无法运行（班次间隙/配额耗尽）时被替换；
- `shift:<id>:quota`：配额用量重算与上报一致且不超配额；
- `objective`：总拖期重算一致。

## 测试

```bash
node --test
```

- `test/acceptance.test.js`：两机台配额内可行且恰好一次抢占；零产能与
  截止期早于释放的边界/失败；未释放工单不被判不可行；证书防篡改；单工单最多被抢占 2 次。
- `test/enumerate.test.js`：≤ 6 个工单的随机实例上，与独立枚举
  （`testlib/enumerate.mjs`，穷举所有机台、顺序与抢占点）对照最优值与可行性。
- `test/cli.test.js`：CLI 退出码、stderr、stdin、`--out`、`verify` 子命令。
