# rect-layout-opt

整数网格上的矩形重布局库：在满足尺寸范围、对齐与不重叠约束的前提下，
最小化各矩形相对旧布局的总移动距离（左上角曼哈顿距离之和）。
纯 TypeScript 编写，运行时仅依赖 Node.js 内置模块，无任何 npm 依赖。

## 模型（`src/model.ts`）

- 矩形坐标与尺寸均为整数，放置在一个 `grid × grid` 的正方形网格内（库按至多 8 个矩形、
  网格 20 的规模设计，参数可任意配置）。
- 每个矩形的宽/高可在 `[minW..maxW] × [minH..maxH]` 范围内自由选择。
- 对齐约束显式声明，支持两种：
  - `pair`：矩形 `a` 的某条边与矩形 `b` 的某条边对齐（`left/right/top/bottom`）；
  - `fixed`：矩形 `a` 的某条边对齐到固定网格线。
- 任意两个矩形不得重叠（边贴边允许）。
- 目标函数：最小化 `Σ (|x - x_old| + |y - y_old|)`。

## 求解器（`src/solver.ts`）

- 最佳优先分支定界：矩形按"最受约束优先"顺序依次赋值；
  节点的精确下界 = 已花费代价 + 每个未赋值矩形与已赋值部分相容的最便宜候选
  （两个未赋值矩形之间的对齐/不重叠被松弛）。
- 子节点入堆时使用 O(1) 增量弱界，出堆时才评估精确界；弱界合法，
  因此堆顶始终是已认证的全局下界。
- `maxNodes` 节点预算耗尽时返回 `budget_exhausted`，同时保留
  当前最优可行解（上界）与堆中最小下界，二者即未闭合预算下的认证区间。
- 求解前会沿赋值顺序做一次贪心下潜，尽早获得上界。

## 约束证书（`src/certificate.ts`）

- `buildCertificate` 输出结构化证书：状态、`lowerBound`/`upperBound`/`gap`、
  布局，以及**逐条约束**的核验结果（每个矩形的尺寸范围与网格边界、
  每对矩形的不重叠、每条对齐约束各一项检查）。
- `verifyCertificate` 独立复验：重新校验布局合法性、重算目标值、
  检查上下界一致性与 `optimal` 状态所要求的零间隙。

## 穷举对照（`src/bruteforce.ts`）

- `bruteForce` 在微小网格上枚举全部合法布局（每个完整布局都用
  `validateLayout` 独立复核），作为求解器的对照 oracle。
- `test/crosscheck.test.ts` 在随机生成的微小网格实例（含对齐约束）上
  断言分支定界目标值与穷举最优值完全一致。

## 使用

```bash
npm test        # 编译 TypeScript 并运行全部测试（node:test）
npm start       # 运行演示：最优闭合 / 预算保留上下界 / 穷举对照
npm run typecheck
```

```ts
import { solve } from './src/solver.js';
import { buildCertificate, verifyCertificate } from './src/certificate.js';

const result = solve(problem, { maxNodes: 200_000 });
const cert = buildCertificate(problem, result);
const issues = verifyCertificate(problem, cert); // [] 表示证书自洽
```

实际运行结果见 `RESULTS.md`。
