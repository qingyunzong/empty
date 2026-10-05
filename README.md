# exact-lp

精确有理数线性规划库（TypeScript + Node.js 内置库，零运行时依赖）。

求解 `max c·x`，满足 `a_i·x (<=|>=|=) b_i`、`x >= 0`，至多 **6 个变量、12 条约束**
（`MAX_VARS` / `MAX_CONSTRAINTS`，超出即抛 `RangeError`）。

## 精确性保证

- 全部算术基于 BigInt 分数（`src/rational.ts` 的 `Frac`，自动约分、分母恒正）。
- 所有符号判断是**精确**的 `sign()` 比较；代码中不存在任何浮点容差 / epsilon。
- 输入接受 `bigint`、安全整数 `number`、以及 `"p/q"` / 十进制字符串（精确解析）；
  非安全整数的 JS number 直接抛错，拒绝悄悄丢失精度。

## 输出与证书

`solveLP` 返回三种状态，每种都带可独立验证的精确证书（`src/check.ts` 的
`verifyResult` 直接针对原始问题表述验证，与求解器代码路径独立）：

- `optimal`：最优值 `value`、原问题解 `x`、对偶解 `y`。
  检查器验证：原可行（含 `x>=0`）、对偶可行（`A^T y >= c`，`y` 符号约束）、
  强对偶 `c·x = b·y = value`。
- `infeasible`：Farkas 证书 `y`（`<=` 行 `y_i>=0`，`>=` 行 `y_i<=0`，`=` 行自由），
  满足 `A^T y >= 0` 且 `b·y < 0`。
- `unbounded`：可行点 `x0` 与射线 `d >= 0`，满足 `c·d > 0` 且沿射线所有约束保持
  （`<=` 行 `a·d<=0`，`>=` 行 `a·d>=0`，`=` 行 `a·d=0`）。

## 算法

两阶段单纯形（字典形式），Bland 规则保证有限终止（`src/lp.ts`）：

1. 约束规范化为 `<=`（`>=` 取负，`=` 拆成两行），记录对偶乘子回映射。
2. 第一阶段对负右端行引入人工变量；最优值 `< 0` 时从目标行松弛变量系数
   读出 Farkas 证书。退化的人工基变量总能被换出（`B^{-1}[A|I]` 的行不可能全零）。
3. 第二阶段求得最优顶点与对偶解（目标行松弛系数的相反数），或在进入列
   无正元素时提取无界射线。

`src/vertex.ts` 提供独立的顶点枚举（对 `[Ahat|I] z = b, z >= 0` 枚举全部基、
精确高斯消元），用于小整数问题的交叉验收：可行域含于非负象限故为 pointed，
非空必有基可行解、有界必在顶点取到最优。

## 用法

```ts
import { solveLP, verifyResult } from './src/index.js';

const lp = {
  numVars: 2,
  objective: [1, 1],
  constraints: [
    { a: [1, 2], rel: '<=', b: 4 },
    { a: [2, 1], rel: '<=', b: 4 },
  ],
} as const;

const res = solveLP(lp);        // { status: 'optimal', value: 8/3, x: [4/3, 4/3], y: [1/3, 1/3] }
verifyResult(lp, res);          // 证书无效则抛出带原因的 Error
```

## 测试

```
npm test    # = tsc -p tsconfig.json && node --test dist/test/*.test.js
```

环境：Node.js v22.22.1，全局 TypeScript 7.0.2（`tsc`），无网络安装任何依赖。

### 实际运行结果（2026-10-05，本仓库工作区）

`npm test` 摘要：`# tests 4 / # pass 4 / # fail 0`（4 个测试文件全部通过）。
逐文件运行 `node dist/test/<name>.test.js` 的实测输出：

```
== rational ==  4/4 通过（约分规范化 / 精确四则 / 无 epsilon 精确比较 / 解析与拒绝非安全整数）
== lp ==       10/10 通过（分数顶点最优、等式混合约束、两类不可行、两类无界、
                零目标、Beale 循环例在 Bland 规则下终止且最优值恰为 1/20、
                冗余/退化约束、规模上限检查）
== check ==    7/7 通过（接受真证书；拒绝篡改的原点/对偶/最优值/假 Farkas/
                假无界射线/错误状态声明）
== random ==   3/3 通过
    400 个随机小整数 LP（<=6 变量、<=12 约束，含等式）：证书全部通过独立检查，
        状态分布 {"optimal":55,"infeasible":238,"unbounded":107}
    150 个小整数 LP 顶点枚举交叉验收：simplex 最优值 == 顶点枚举最优值，
        simplex 不可行 <=> 无基可行解，
        状态分布 {"optimal":38,"infeasible":81,"unbounded":31}
    等式密集实例：14 个最优值与顶点枚举逐一相符
```

## 文件结构

- `src/rational.ts` — BigInt 精确分数
- `src/lp.ts` — 两阶段精确单纯形与证书提取
- `src/check.ts` — 独立证书检查器
- `src/vertex.ts` — 顶点枚举交叉验证器
- `src/index.ts` — 导出入口
- `test/` — node:test 测试（单元 + 篡改 + 随机交叉验收）
- `types/node-shims.d.ts` — node:test / node:assert 的最小类型声明（离线环境无 @types/node）
