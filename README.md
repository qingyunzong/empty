# exact-lp

精确有理数线性规划求解库：至多 **6 个变量、12 条约束**，全程 **BigInt 精确有理数运算**，
不使用任何浮点容差冒充精确判断。只依赖 Node.js 内置模块，运行时零依赖。

## 功能

- 求解 `max|min c·x`，约束 `aᵢ·x (<=|>=|=) bᵢ`，变量默认非负、可声明自由变量
- 三种结局，均附带**可独立检验的精确证书**：
  - `optimal`：最优值 + 原始顶点 `x*` + 对偶解 `y*`（强对偶 `c·x* = b·y*` 精确成立）
  - `infeasible`：Farkas 证书 `y`（符号受限、`Aᵀy ≥ 0`、`b·y < 0`，全部精确）
  - `unbounded`：可行点 `x₀` + 射线 `d`（`d ≥ 0`、`Ad` 方向受限、`c·d > 0`）
- `checkResult(problem, result)`：独立证书检验器，只做精确有理数等式/不等式判定，
  1/10¹⁸ 量级的篡改也会被拒绝
- `solveByEnumeration`：顶点枚举求解器（与单纯形不共享主元代码），用于交叉验证；
  无界性通过对有界射线 LP `max c·d, Ad≤0, d≥0, Σdⱼ≤1` 的枚举精确判定

## 精确性保证

- 所有数表示为约分后的 `num/den`（BigInt），比较即精确符号判断，无 epsilon
- 非整数 JS `number`（如 `0.1`）**直接抛错**；请传字符串 `"0.1"`（精确解析为 1/10）或 `"p/q"`
- 单纯形采用 Bland 最小指标规则，理论上保证终止（不循环），无需任何容差

## 用法

```ts
import { solve, checkResult } from "./src/index.js";

const problem = {
  numVars: 2,
  objective: [3, 2],               // max 3x + 2y
  constraints: [
    { coeffs: [1, 2], sense: "<=", rhs: 4 },
    { coeffs: [2, 1], sense: "<=", rhs: "5/1" },
  ],
};
const result = solve(problem);
// { status: "optimal", objectiveValue: 8, primal: [2, 1], dual: [1/3, 4/3] }
checkResult(problem, result);      // { ok: true }
```

## 实现要点

- `src/rational.ts`：BigInt 分数四则运算与精确解析
- `src/lp.ts`：问题规范化（min→max、`>=`/`=` 拆分、自由变量拆分为 `x⁺−x⁻`），
  并维护原始/规范形式之间的证书映射
- `src/simplex.ts`：两阶段字典单纯形（Bland 规则）；对偶解取自松弛变量检验数相反数，
  Farkas 证书取自第一阶段目标行，无界射线取自进基列
- `src/certificates.ts`：独立检验器（原始可行、对偶可行、强对偶等式 / Farkas 三条 / 射线三条）
- `src/enumerate.ts`：精确顶点枚举 + 射线 LP，组合数超限（默认 20 万）时明确返回 `skipped`

## 测试

```
npm test        # tsc 编译后运行 node --test
```

实际运行结果（Node v22.22.1，tsc 7.0.2，2026-10-05）：

```
# tests 5 个文件 / 40 个用例
# pass 40
# fail 0
# duration_ms ≈ 1030
```

- `rational.test.js`（7）：约分/符号规范化、精确小数解析、非整数 number 拒绝、
  大数精确运算（10³⁰ 量级）、精确比较、往返序列化
- `simplex.test.js`（13）：有界最优（含分数顶点 `7/6`）、不可行（含等式）、无界（含自由变量）、
  等式约束、最小化、Beale 循环例子（Bland 规则终止，最优值 1/20）、退化问题、
  规模限制拒绝、10⁻³⁰ 精度最优值
- `certificates.test.js`（11）：合法证书全部接受；篡改最优值（含 −1/1000）、不可行原始点、
  对偶符号/可行性破坏、假 Farkas、假射线、10⁻¹⁸ 量级原始违反均被拒绝
- `enumerate.test.js`（7）：精确线性方程组求解、与单纯形交叉验证（最优/不可行/无界/
  等式+自由变量/Beale/最小化）
- `random.test.js`（2 套件，确定性种子）：
  - 套件 A：150 个随机整数 LP（≤6 变量、≤12 约束），证书全部精确通过
    （optimal 19 / infeasible 94 / unbounded 37）
  - 套件 B：120 个小型随机 LP 与顶点枚举逐一交叉验证，状态与最优值完全一致
    （optimal 23 / infeasible 75 / unbounded 22）
