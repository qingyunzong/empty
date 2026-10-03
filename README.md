# inspection-planner

离线巡检计划库与 CLI。基于有限域 CSP：每个任务有人员变量（技能覆盖的巡检员集合）
与整数开始时间变量（时间窗内），传播技能集合、时间窗与单任务序列（同一巡检员
的不可重叠约束，含跨区域整数移动时间），回溯枚举人员分配与任务排序，最小化
最晚完工时间（makespan），并列时最小化总移动时间。

## 输入格式

```json
{
  "skills": ["electrical", "plumbing"],
  "inspectors": [{ "id": "p1", "skills": ["electrical"] }],
  "travel": { "A": { "B": 2 }, "B": { "A": 2 } },
  "tasks": [
    { "id": "t1", "zone": "A", "skills": ["electrical"], "duration": 3, "window": [0, 8] }
  ]
}
```

- `skills`：顶层技能全集（必填），任务/巡检员引用未声明技能视为“缺失技能”。
- `window`：`[最早开始, 最晚开始]`，整数且 `0 <= earliest <= latest`。
- `travel`：区域间整数移动时间，省略的条目默认为 0，不允许负值。

## CLI

```sh
plan input.json --budget 500
# 或
node src/cli.js plan input.json --budget 500
```

结果 JSON 写 stdout，诊断写 stderr。退出码：

| 退出码 | 含义 |
| ------ | ---- |
| 0 | `optimal`：找到并证明最优解 |
| 1 | `infeasible`：不可行，输出任务/人员/时间窗构成的冲突证明 |
| 2 | 输入错误：缺失技能、负移动时间、非法窗口等 |
| 3 | `unknown`：分支预算耗尽，列出仍无单一赋值的未决任务 |

## 库

```js
import { solve } from './src/solver.js';
const result = solve(input, { budget: 500 });
// result.status: 'optimal' | 'infeasible' | 'unknown'
```

## 测试

```sh
node --test
```

- `test/optimal.test.js`：三人四任务小例与暴力枚举（人员分配 × 任务排列）对照最优。
- `test/infeasible.test.js`：高技能任务无人具备时返回不可行冲突证明。
- `test/budget.test.js`：预算阈值附近分别复现 `unknown` 与 `optimal`。
- `test/cli.test.js`：CLI 退出码与输出契约。
