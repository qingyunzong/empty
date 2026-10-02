# mach-sched

机加工排程库与 CLI（Node.js 22 标准库，无第三方依赖）。

每道工序选择**机床、整数槽位、刀具**；工序带机床候选集、切削分钟数与夹具要求。
约束以有限域传播维护：

- 同机工序槽位不重叠（`machineBusy`）
- 每把刀累计切削时间不超过寿命（`toolLoad` 累计传播）
- 同一夹具同一时刻只服务一道工序（`fixtureBusy` 互斥传播）

回溯搜索（MRV + 分支限界）最小化总超期步数 `sum(max(0, slot - due))`。

## 问题格式（JSON）

```json
{
  "slots": 4,
  "machines": ["M1", "M2"],
  "tools": { "T1": { "life": 20 }, "T2": { "life": 8 } },
  "fixtures": ["F1"],
  "ops": [
    { "id": "A", "machines": ["M1", "M2"], "tools": ["T1"], "cut": 5, "fixture": "F1", "due": 0 }
  ]
}
```

`due` 省略时默认为 `slots - 1`（不会超期）。

## CLI

```sh
node bin/cli.js schedule problem.json [--budget N]
node bin/cli.js replace replace.json
```

`replace.json` 格式：`{ "problem": ..., "assignment": {...}, "op": "B", "newOp": {...} }`。

退出码：

- `0` — optimal / 替换成功
- `1` — infeasible（输出含工序—刀具/夹具冲突证明 `proof`/`conflicts`）
- `2` — 非法输入（非整数、未知刀具/机床/夹具、JSON 错误等）
- `3` — unknown（预算耗尽，输出 `pending` 未决工序与 `incumbent`）

## 替换工序（库 API）

```js
import { validateProblem } from './src/problem.js';
import { Solver } from './src/solver.js';

const solver = new Solver(validateProblem(raw));
const result = solver.solve();          // { status: 'optimal', assignment, tardiness }
solver.commit(result.assignment);       // 每道工序一个传播层级
const r = solver.replaceOp('B', newOp); // 层级回滚 B 触发的槽位/刀具/夹具传播，
                                        // 再增量加入新工序；其他赋值保持不变
```

替换不可行时返回 `{ status: 'infeasible', proof }` 并自动恢复旧工序状态。

## 测试结果（真实运行记录）

`node --test`，Node v22.22.1，2026-10-03 运行：

```
✔ test/cli.test.js
✔ test/solver.test.js
# tests 2  # pass 2  # fail 0   （子测试 15/15 通过：solver 6 + cli 9）
```

验收覆盖：

1. `test/solver.test.js` — 40 个随机小规模问题与暴力枚举全部机床/刀具/槽位组合对照，最优超期步数一致。
2. 刀具寿命边界（life=10 可行、life=9 不可行）及搜索派生不可行，证明均指出超限刀。
3. 替换工序后旧槽位/夹具占用完全撤销、共享刀具累计值正确（T1: 5+7=12）、其他赋值不变；超寿命替换返回冲突证明并恢复旧状态。
