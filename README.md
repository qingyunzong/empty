# molding-scheduler

注塑车间离散时隙排产库与 CLI。仅使用 Node.js 22 标准库，完全离线运行，
测试基于 `node:test`。

## 问题模型

- 时间在离散时隙 `0, 1, 2, …` 上推进。所有生产必须落在某个班次的
  `[start, end)` 窗口内；求解时界为最后一个班次的结束时刻（之后不存在任何
  产能，因此在该时界内穷举即可判定可行性）。
- **机台**：每台机一次最多加工一个工单。每个工单被指派到**一台**兼容机台，
  其所有加工段都在该机台上完成（模具随机台走）。
- **班次与配额**：每个班次对每产品族有一个产能配额（时隙数，跨机台共享）。
  在时隙 `t` 生产族 `f` 要求：某个班次覆盖 `t` 且该班次族 `f` 的剩余配额 > 0，
  生产后配额减 1。
- **工单**：含释放时刻 `release`、加工时长 `duration`（时隙数）、截止期
  `deadline`、产品族 `family`、优先级 `priority` 与兼容机台列表 `machines`。
  优先级取 `critical | high | medium | low`。
- **抢占**：只有 `critical` 工单可以抢占，且只能抢占严格更低优先级（即非
  critical）的工单；抢占只能发生在整数时隙边界（模型本身即离散）。每次抢占
  在被抢占工单当前段之后、抢占工单开始之前插入 **1 个换模时隙**（占用机台、
  不消耗配额）；每个工单最多被抢占 **2 次**。critical 工单不会被抢占
  （一旦开始必然连续运行至完成，班次间隔造成的停顿除外）。
- **目标**：最小化总拖期 `Σ max(0, C_i − deadline_i)`。总拖期并列时，按工单
  编号字典序比较各工单的完成时刻向量（工单按 id 字典序排列），取字典序较
  小者。
- **可行性**：释放时刻尚未到达**不**等于不可满足——求解器会等待到释放之后
  的班次产能。只有在释放之后全族配额不足、释放时刻已晚于所有班次、无兼容
  机台或搜索证明机台/班次产能无法完成全部工单时，才返回 `infeasible` 并附
  具体原因。`deadline < release` 是合法边界输入：工单仍会被排产，只是必然
  拖期。

## 输入格式（JSON）

```json
{
  "machines": [{ "id": "M1" }, { "id": "M2" }],
  "shifts": [
    { "id": "S1", "start": 0, "end": 12, "quotas": { "A": 5, "B": 5 } }
  ],
  "orders": [
    {
      "id": "B1", "release": 0, "duration": 4, "deadline": 8,
      "family": "B", "priority": "low", "machines": ["M1"]
    }
  ]
}
```

- `machines`：非空数组，元素为 `{"id": "..."}` 或机器 id 字符串，id 唯一。
- `shifts`：数组（可为空），`start`/`end` 为非负整数且 `end > start`，班次
  不得重叠；`quotas` 为 族 → 非负整数时隙数。`id` 可省略（默认 `S1`、`S2`…）。
- `orders`：数组（可为空）。`release`/`duration`/`deadline` 为非负整数，
  `duration ≥ 1`；`priority` 省略时默认为 `low`；`machines` 必须引用已声明
  的机台 id（空数组合法，该工单将被判定为不可行原因而非非法输入）。

任何违反上述约束的输入都属于**非法输入**：CLI 退出码 1，错误信息写入
stderr。

## CLI 用法

```bash
node cli.js solve instance.json     # 求解，JSON 结果写 stdout
node cli.js instance.json           # solve 是默认命令
cat instance.json | node cli.js     # 从 stdin 读取（路径省略或为 "-"）
node cli.js verify instance.json solution.json   # 独立逐项核验证书
```

退出码：

- `0`：求解成功（包括证明为 `infeasible` 的情形）或证书核验通过；
- `1`：非法输入 / 用法错误（信息写 stderr），或 `verify` 模式下证书核验失败。

## 输出格式

```json
{
  "status": "optimal",
  "objective": { "totalTardiness": 0 },
  "orders": [
    {
      "id": "B1", "machine": "M1",
      "segments": [{ "start": 0, "end": 1 }, { "start": 5, "end": 8 }],
      "completion": 8, "deadline": 8, "tardiness": 0, "preemptions": 1
    }
  ],
  "machines": [
    {
      "id": "M1",
      "slices": [
        { "start": 0, "end": 1, "type": "production", "order": "B1" },
        { "start": 1, "end": 2, "type": "changeover", "preempted": "B1", "by": "C1" }
      ]
    }
  ],
  "quotaUsage": [{ "shift": "S1", "family": "A", "used": 5, "capacity": 5 }],
  "preemptions": {
    "total": 1,
    "byOrder": { "B1": 1 },
    "events": [{ "slot": 1, "machine": "M1", "preempted": "B1", "by": "C1" }]
  },
  "certificate": { "ok": true, "checks": [{ "name": "...", "ok": true, "detail": "..." }] }
}
```

- 无可行方案时输出 `{"status": "infeasible", "reasons": ["..."]}`（退出码仍
  为 0，因为这是合法的求解结论）。
- `certificate` 由求解器自检生成，也可用 `verify` 子命令或库函数
  `verifySolution(instance, solution)` 独立重算。核验逐项进行，检查项包括：
  - `status-optimal` / `machines-section-wellformed` / `slices-wellformed`；
  - `machine-timelines-nonoverlapping`：每台机时间片不重叠；
  - `order-single-compatible-machine`：每工单只在一台兼容机台上加工；
  - `release-respected`：生产时隙不早于释放时刻；
  - `production-within-shifts`：生产时隙全部落在班次窗口内；
  - `all-orders-complete-exact-duration`：每工单生产时隙总数恰为 `duration`；
  - `shift-quotas-respected`：每班次每族用量不超过配额；
  - `quota-usage-table-accurate`：上报的配额用量表与重算结果一致；
  - `preemption-protocol`：每次换模前是被抢占（非 critical、未完成）工单的
    生产段，换模后一个时隙立即开始 critical 抢占工单，且抢占工单已释放；
  - `interruption-only-by-preemption`：工单未完成离开机台只能因为被
    critical 抢占，恢复生产前必须存在对应抢占记录；
  - `preemption-limit-two`：每工单被抢占次数 ≤ 2；
  - `order-records-accurate` / `total-tardiness-accurate` /
    `preemption-records-accurate`：上报的完成时刻、拖期、抢占统计与切片
    重算结果一致。

## 库 API

```js
import { validateInstance, InputError } from './src/instance.js';
import { solve } from './src/solver.js';
import { verifySolution } from './src/verify.js';

const instance = validateInstance(rawJson);   // 非法输入抛 InputError
const solution = solve(instance);             // optimal | infeasible
const certificate = verifySolution(instance, solution);
```

## 求解方法

精确的分支限界搜索：按全局时隙推进，每台机在每个时隙选择 生产 / 换模抢占
/ 空闲，剪枝包括拖期下界、并列规则下界、逐工单剩余产能可行性与机台时隙总
量上界；当所有机台只能空闲时直接跳到下一个事件（释放或班次开始）时隙。
结果对给定模型是最优的。

## 测试

```bash
npm test          # 即 node --test
```

- `test/acceptance.test.js`：验收场景——两机台配额内可行且恰好发生一次抢占；
  零产能不可行；截止期早于释放的边界（可行但必拖期）；未来释放时刻不被误判
  为不可满足；释放晚于所有班次的失败原因；每工单最多被抢占 2 次。
- `test/verify.test.js`：证书逐项核验——接受真实证书，拒绝释放前生产、配额
  超限、第 3 次抢占、非 critical 抢占、工单丢失、抢占统计谎报、班次外生产等
  伪造证书。
- `test/cli.test.js`：以真实子进程端到端运行 CLI——stdin/文件输入、非法输入
  退出码 1 且写 stderr、infeasible 输出、verify 子命令接受真证书拒绝假证书。
- `test/bruteforce.test.js`：60 个确定性随机实例（≤ 6 个工单，含专为抢占
  设计的模板），与 `test-helpers/enumerate.js` 中**独立编写**的暴力枚举
  （枚举所有机台指派、加工顺序与抢占点）对照最优总拖期、完成时刻向量与可行
  性，并逐例核验证书。对照结果记录在
  `test-results/bruteforce-results.json`（含种子、可行/不可行/含抢占最优解
  计数与逐例明细）。
