# energy-scheduler

次日可移峰设备用电计划器：DSL → 静态类型检查 → 字节码 → VM（15 分钟离散槽）→ 最优调度。
仅使用 Node.js 22 标准库，单机离线，无第三方依赖。

## 快速开始

```sh
node bin/energy.js schedule examples/site.dsl --json plan.json
node bin/energy.js verify plan.json
node --test
```

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/lexer.js` | 词法分析：`kW`/`kWh`/`min`/`元` 单位、`HH:MM` 时刻、`#` 注释，行列号跟踪 |
| `src/parser.js` | 递归下降 + Pratt 解析器（窗口 `..`、先后关系 `after`/`before`、目标表达式 `+ - * /` 优先级） |
| `src/checker.js` | 静态类型检查：功率/能量/时刻/电价单位，设备模板词法作用域（site 内模板遮蔽全局模板） |
| `src/compiler.js` | 约束编译为字节码：`BLOCK`/`ADDRANGE`/`CHKBLOCK`/`CHKPEAK`/`HALT` |
| `src/vm.js` | 虚拟机：对 15 分钟离散槽累计负荷并执行硬约束检查 |
| `src/scheduler.js` | 模式生成 + DFS 分支限界求解器；`Scheduler` 支持 `addTask`/`savepoint`/`rollback` 与结果缓存 |
| `src/reference.js` | 暴力枚举参考实现（测试用来交叉验证 ≤8 任务实例） |
| `src/plan.js` | 计划 JSON 生成与 `verify` 校验 |
| `src/cli.js` | 命令行入口 |

## DSL 参考

```
# 注释
template Pump {                  # 设备模板（词法作用域，site 内可遮蔽全局）
  power 40 kW                    # 功率（kW）
  duration 60 min                # 时长（分钟，须对齐槽长）
}

site Factory {
  slots 96                       # 槽数（默认 96）
  slotMinutes 15                 # 槽长（默认 15 分钟）
  tariff 0.8                     # 单一电价（元/kWh），或分时块：
  # tariff { 00:00 .. 08:00 -> 0.32 元  08:00 .. 24:00 -> 0.95 元 }
  carbon 0.55                    # 碳排因子（kg/kWh），同样支持分时块
  costBudget 200                 # 电费预算（元，可选）
  carbonBudget 400               # 碳排预算（kg，可选）
  peakLimit 120 kW               # 峰值硬约束（可选）
  maintenance 10:00 .. 11:00     # 维护窗（禁止负荷，可多条）

  task pumpA : Pump {            # 引用模板，字段可覆盖
    window 06:00 .. 12:00        # 最早/最晚窗口 [start, end)
  }
  task pumpB : Pump {
    window 06:00 .. 14:00
    after pumpA                  # 先后关系：pumpB 在 pumpA 结束后开始
  }
  task ev {
    power 7 kW
    energy 14 kWh                # 可用 energy(kWh) 代替 duration（duration = energy/power）
    interruptible true           # 可中断
    maxInterrupts 2              # 最多中断次数（运行段数 ≤ 中断数+1）
    window 00:00 .. 04:00
  }

  objective minimize cost + 0.5 * peak   # 目标表达式（Pratt 解析；默认 minimize cost）
}
```

## 调度语义

- 目标：最小化 `objective` 表达式（默认电费 `cost`）。
- 并列最优依次比较：① 峰值较低；② 按开始时刻排序的任务 ID 序列字典序较小；③ 完整分配字典序（保证结果唯一确定）。
- 硬约束（窗口、维护、峰值上限、先后关系、中断限制）无可行解 → `INFEASIBLE`。
- 有解但最优解超过 `costBudget` 或 `carbonBudget` → `OVER_BUDGET`，输出中列出最低成本方案及其成本。
- 金额/碳排按整数标度（1e6）精确计算，预算“刚好满足”与“差一单位”判定无浮点误差。

## CLI 与退出码（实测）

```
energy schedule <site.dsl> [--json plan.json]
energy verify <plan.json>
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功：计划在预算内 / 计划校验通过 |
| 1 | `verify`：计划无效或不是最优 |
| 2 | 用法、IO、词法/语法/类型错误（错误信息带 `文件:行:列`） |
| 3 | `schedule`：`INFEASIBLE` |
| 4 | `schedule`：`OVER_BUDGET` |

`--json` 省略时计划 JSON 打到 stdout，摘要打到 stderr。`verify` 依据计划内嵌的
源文件路径（相对计划文件）与 SHA-256 重新求解，校验硬约束、负荷/成本/峰值一致性与最优性。

## 增量 API

```js
import { Scheduler } from './src/scheduler.js';
const sched = new Scheduler(site);
sched.savepoint('sp1');
sched.addTask({ id: 't2', watts: 1000, durationSlots: 2, winStart: 0, winEnd: 8,
                interruptible: false, maxInterrupts: null, after: [], before: [] });
sched.solve();
sched.rollback('sp1');   // 缓存按完整状态哈希键控，回滚不会污染结果
```

## 测试

```sh
node --test
```

最近一次运行结果（真实输出）：8 个测试文件全部通过，共 51 个用例，51 通过 / 0 失败，
`node --test` 进程退出码 0。覆盖验收点：

1. 可行调度与并列最优（峰值并列、任务 ID 字典序）— `test/scheduler.test.js`
2. 预算刚好满足与差一单位（电费/碳排）— `test/scheduler.test.js`、`test/cli.test.js`
3. 维护窗导致 `INFEASIBLE` — `test/scheduler.test.js`、`test/cli.test.js`
4. 增量 `add-task` 后 `rollback` 到命名保存点，缓存不污染 — `test/scheduler.test.js`
5. ≤8 任务与暴力枚举参考实现一致（随机种子实例，含 INFEASIBLE/OVER_BUDGET）— `test/reference.test.js`

已知边界：可中断任务的候选模式按组合枚举，窗口过大（如 32 槽选 12 槽）会超出
枚举上限并报错；请收窄窗口或改用不可中断任务。
