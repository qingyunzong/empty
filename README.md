# 投放规划 CLI（ad-delivery-planner）

整数投放量优化器：在**分渠道预算**与**总曝光下限**约束下，为至多 **16 个广告组**
选择 **0–10 的整数投放量**，使**总收益最大**；收益并列时取**总成本最低**者。
收益表为非线性查表（每组 11 个整数值）。全部输入数值必须为整数。
求解后输出可校验的**预算证书**（JSON），并可用内置穷举求解器对小规模实例做交叉验证。

纯 TypeScript + Node.js 内置库（`node:test` / `node:crypto` / `node:fs` 等），零运行时依赖。

## 构建与测试

```bash
npm test          # tsc 编译到 dist/ 并运行 node:test 测试（需要全局可用的 tsc）
npm run build     # 仅编译
```

## 使用

```bash
node dist/src/cli.js <input.json | -> [--brute] [--pretty] [--out cert.json]
```

- `input.json`：输入文件；`-` 表示从标准输入读取
- `--brute`：额外运行穷举求解器（11^n 全枚举），在证书中写入交叉验证结果
- `--pretty`：缩进格式化输出
- `--out <file>`：证书写入文件而非标准输出
- 退出码：`0` 已求得最优解；`1` 无可行解；`2` 输入非法/用法错误

### 输入格式

```json
{
  "channels": [{ "id": "search", "budget": 40 }],
  "minImpressions": 60,
  "groups": [{
    "id": "g1",
    "channel": "search",
    "unitCost": 3,
    "unitImpressions": 8,
    "revenue": [0, 6, 11, 15, 18, 20, 21, 22, 23, 24, 25]
  }]
}
```

校验规则：`groups` 至多 16 个；`revenue` 必须恰好 11 个整数（对应投放量 0..10）；
所有数值为整数且非负；`channel` 必须引用已声明的渠道；id 唯一。

### 输出（预算证书）

证书包含：每组投放量/成本/曝光/收益明细；每渠道 `budget/spent/remaining/withinBudget`；
曝光下限达成情况；四项一致性检查（`allIntegers`、`amountsWithinRange`、
`allBudgetsRespected`、`impressionsSatisfied`）；最优性说明（精确 DP 探索状态数、
可选的穷举对照结果 `matches`）；以及对关键结果字段的 SHA-256 `fingerprint`。

## 求解方法

- **精确 DP（默认）**：先在每个渠道内对其广告组做动态规划，得到该渠道预算内
  （曝光, 成本, 收益）三维帕累托前沿（曝光超过下限即截断，因为目标只关心收益与成本）；
  再跨渠道合并前沿。支配规则：若存在 `imp' ≥ imp`、`cost' ≤ cost`、`rev' ≥ rev`
  的条目，则本条被剪枝——该规则与"收益最大、并列成本最低"的目标一致，保证精确。
- **穷举对照（`--brute` / 测试）**：递归枚举全部 11^n 组合（带预算前缀剪枝），
  用于小规模实例的正确性交叉验证。

## 实际运行结果（本机实测）

`npm test`（Node v22.22.1，tsc 7.0.2）：

```
ok 1 - dist/tests/cli.test.js
ok 2 - dist/tests/solver.test.js
# tests 2
# pass 2
# fail 0
```

共 12 个用例全部通过：

```
solver.test.js:
  ok 1 - known case: hand-computed optimum
  ok 2 - tie on revenue picks the cheaper allocation
  ok 3 - infeasible when impressions lower bound is unreachable
  ok 4 - per-channel budgets are enforced independently
  ok 5 - 16 groups solve quickly and match brute force on a constrained instance
  ok 6 - randomized cross-check: DP matches brute force (small instances)
  ok 7 - validation rejects malformed input
cli.test.js:
  ok 1 - CLI solves the sample and emits a valid budget certificate
  ok 2 - CLI reads the problem from stdin with '-'
  ok 3 - CLI exits 1 with an infeasible certificate when unsatisfiable
  ok 4 - CLI exits 2 on invalid input and on bad usage
  ok 5 - end-to-end: compiled CLI runs as a child process and writes --out file
```

示例求解（`node dist/src/cli.js examples/sample.json --brute`，退出码 0）：

```
objective: {"revenue":91,"cost":70,"impressions":170}  amounts: 5,5,5,5
bruteForce: {"nodes":3906,"revenue":91,"cost":70,"matches":true}
```

额外压力验证（测试套件之外）：200 个随机实例（1–6 组、1–3 渠道，含 56 个不可行实例）
DP 与穷举全部一致，耗时 438ms。

> 注：本沙箱环境会吞掉孙进程的 stdout 管道，因此端到端测试通过 `--out` 文件回收输出；
> 日常终端使用不受影响。
