# quality-trace

质量追溯库与 CLI（Node.js 22 标准库，无第三方依赖）。

生产批次从候选原料批中选择整数投入量，形成可追溯谱系。系统以有限域表示
候选父批与投入量，先传播质量状态（隔离污点闭包）、有效期与数量上下界，
再回溯搜索可行谱系；支持事务式 undo/redo。

## 约束

| 约束 | 说明 |
| --- | --- |
| `input-sum` | 总投入 = 产出量 + 固定损耗 |
| `no-quarantine` | 不得直接或间接使用隔离批（污点沿谱系边传播） |
| `expiry-order` | 产出批有效期不得晚于所用父批有效期 |
| `line-non-overlap` | 同产线批次时间窗口不得重叠 |
| `availability` | 父批被消耗总量不得超过其可用数量 |

## 输入格式

```json
{
  "budget": 100000,
  "batches": [
    { "id": "M1", "kind": "material", "quantity": 40, "expiry": "2026-06-01", "status": "released" },
    { "id": "P1", "kind": "production", "line": "L1", "start": "2026-02-01", "end": "2026-02-03",
      "outputQty": 45, "loss": 5, "expiry": "2026-04-01", "candidates": ["M1"] }
  ]
}
```

- `quantity`/`loss` 为非负整数，`outputQty` 为正整数，否则退出码 2。
- `candidates` 引用必须存在且无环（断裂引用退出码 2）。
- 生产批可作为其他生产批的候选父批，其可用量为 `outputQty`。

## CLI

```sh
node cli.js trace input.json [--state .trace-state.json] [--budget N]
node cli.js undo  [--state .trace-state.json]
node cli.js redo  [--state .trace-state.json]
```

`trace` 将输入装载与求解结果（谱系边 + 传播结论）作为两个事务写入状态
文件；`undo` 同时移除谱系边与传播结论，`redo` 原样重放。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | `feasible`（或 undo/redo 成功） |
| 1 | `infeasible`，输出参与矛盾的批次/约束证明（`proof`） |
| 2 | 非法数量、断裂引用、环、用法错误 |
| 3 | `unknown`：预算耗尽，`pending` 列出未决选择 |

### 输出

- `feasible`：`edges` 谱系边，`derived.domains` 有限域，
  `derived.expiryBound` 沿谱系传播的有效期上界。
- `infeasible`：`proof.constraints`/`proof.batches` 参与矛盾的约束与批次，
  `proof.chains` 隔离污点完整冲突链（如 `M1>P1>P2>P3`）。
- `unknown`：`pending.decided`/`pending.undecided` 未决选择。

## 库 API

```js
import { parseModel } from './src/model.js';
import { solve } from './src/solver.js';
import { TraceStore } from './src/store.js';
import { runTrace } from './src/trace.js';
```

## 测试

```sh
node --test
```

- `test/oracle.test.js`：小实例上枚举所有合法父批子集与数量组合的暴力
  对照（400 个随机实例逐解计数比对）。
- `test/quarantine.test.js`：隔离批多层传递失败的完整冲突链。
- `test/undoredo.test.js`：undo 恢复添加前状态、redo 结果一致。
- `test/cli.test.js`：真实子进程运行 CLI，记录真实输出与退出码。
