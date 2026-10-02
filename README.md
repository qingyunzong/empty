# energy-scheduler

工厂次日可移峰设备用电计划器。DSL 描述站点（电价、碳强度、预算、设备模板、任务、维护窗、先后关系、目标），约束编译为字节码，VM 在 96 个 15 分钟离散槽上计算负荷，求解器搜索最小电费方案。仅使用 Node.js 22 标准库，单机离线。

## 架构

```
site.dsl ──► lexer ──► parser(Pratt) ──► types(静态检查) ──► spec
                                                              │
              ┌──────────────────────────────────────────────┤
              ▼                                              ▼
        compiler(字节码) ──► VM(96 槽负荷/缓存) ◄── solver(DFS+分支限界+记忆化)
                                                              │
                                                              ▼
                                            plan.json ◄── verify(独立重算)
```

- `src/lexer.js`：词法层。单位 `kW` / `kWh` / `min`、电价数字、时刻 `HH:MM`、`#` 注释；错误带行列。
- `src/parser.js`：Pratt 表达式解析（目标表达式、数值字段，优先级 `*`/`/` > `+`/`-`，支持括号与一元负号）；窗口 `HH:MM-HH:MM`、`order A before B` 先后关系。
- `src/types.js`：静态类型检查。功率(kW)/能量(kWh)/时长(min)/时刻（15 分钟槽对齐）；设备模板词法作用域：父模板须先定义，子模板字段遮蔽父模板，任务覆盖模板，同一作用域重复定义报错。
- `src/compiler.js` / `src/vm.js`：约束编译为字节码（`ADD/ZERO/CAP/COST/CARBON/PEAK/HALT`），VM 在 15 分钟槽上累计负荷并校验容量与维护窗；VM 带结果缓存，支持保存点快照与回滚。
- `src/solver.js`：按任务 ID 字典序 DFS，费用下界剪枝 + 状态记忆化。目标默认 `minimize cost`；**并列最优依次取峰值较低、任务 ID 字典序较小方案**。
- `src/reference.js`：暴力枚举参考实现（无剪枝无记忆化），测试中与求解器交叉验证。
- `src/session.js`：增量 API。`savepoint(name)` / `addTaskDsl(...)` / `rollback(name)`；回滚同时截断 VM 缓存，缓存不污染后续结果。
- `src/plan.js`：`plan.json` 构建与独立校验（复用编译器 + VM 重算）。

## DSL 参考

```
# 注释
site "Demo" {
  capacity 40 kW                       # 可选，默认不限
  tariff  { price 00:00-06:00 0.30  price 06:00-24:00 0.80 }
  carbon  { intensity 00:00-24:00 0.50 }
  budget  { cost 60  carbon 25 }       # 可选
  maintenance 12:00-12:45              # 维护窗内负荷必须为 0

  template Pump {                      # 设备模板（词法作用域）
    power 10 kW
    duration 60 min                    # 或 energy 5 kWh（二选一）
    window 08:00-20:00
    interruptible true                 # 可选，默认 false
    maxInterruptions 2                 # 可选，可中断时默认 2
  }
  template Line : Pump { power 20 kW } # 继承并遮蔽

  task p1 : Pump
  task p2 : Pump { window 10:00-14:00 } # 覆盖模板字段
  order p1 before p2                    # p1 结束早于 p2 开始

  minimize cost                         # 可选，支持 cost/peak/carbon 与 + - * / 表达式
}
```

时刻必须对齐 15 分钟槽（`mm ∈ {00,15,30,45}`），时长亦然。

## CLI

```
node bin/energy-sched.js schedule site.dsl --json plan.json
node bin/energy-sched.js verify plan.json
```

`schedule` 输出示例：

- `FEASIBLE cost=24 peak=20 carbon=15`
- `OVER_BUDGET minCost=61 costBudget=60 carbon=25 carbonBudget=25`（列出最低成本）
- `INFEASIBLE`

### 退出码（实测）

| 命令 | 退出码 | 含义 |
| --- | --- | --- |
| `schedule` | 0 | 可行且在预算内（FEASIBLE） |
| `schedule` | 1 | 硬约束无解（INFEASIBLE）或超预算（OVER_BUDGET） |
| `schedule` | 2 | 词法/语法/类型/IO 错误，stderr 形如 `site.dsl:3:8: error: ...` |
| `verify` | 0 | 计划校验通过（OK） |
| `verify` | 1 | 计划违反约束或指标不符（INVALID: ...） |
| `verify` | 2 | 文件无法读取或 JSON 非法（带行列） |

## 增量 API

```js
import { Session } from './src/session.js';
const s = new Session();
s.load(dslText);
s.savepoint('base');
s.addTaskDsl('task p3 : Pump { window 00:00-06:00 }');
s.solve();
s.rollback('base'); // 任务与 VM 缓存一并回滚
```

## 测试

```
node --test
```

最近一次运行：**50 通过 / 0 失败**（8 个测试文件）。

| 文件 | 通过 | 覆盖 |
| --- | --- | --- |
| `test/lexer.test.js` | 6 | 单位/注释/时刻/错误行列 |
| `test/parser.test.js` | 5 | Pratt 优先级、窗口、先后关系、增量片段 |
| `test/types.test.js` | 13 | 单位检查、槽对齐、模板词法作用域、能量换算 |
| `test/solver.test.js` | 9 | 可行及并列最优、预算刚好/差一单位、维护窗 INFEASIBLE、可中断 |
| `test/session.test.js` | 4 | 增量 add-task、回滚到命名保存点、缓存不污染 |
| `test/reference.test.js` | 2 | 随机实例（含 8 任务）与暴力枚举一致 |
| `test/vm.test.js` | 3 | 字节码负荷/费用/碳排/峰值、断言违例、缓存回滚 |
| `test/cli.test.js` | 8 | 退出码 0/1/2、plan.json 生成与校验、篡改检出 |

验收映射：①可行及并列最优 → `solver.test.js`；②预算刚好满足和差一单位 → `solver.test.js`；③维护窗 INFEASIBLE → `solver.test.js`；④增量添加后回滚 → `session.test.js`；⑤≤8 任务与暴力枚举一致 → `reference.test.js`。

## 示例

```
node bin/energy-sched.js schedule examples/site.dsl --json /tmp/plan.json
node bin/energy-sched.js verify /tmp/plan.json
```
