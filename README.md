# tvl-policy

一个基于 **Kleene 三值逻辑** 与 **精确有理数比较** 的策略库（TypeScript，零运行时依赖，仅用 Node.js 内置模块）。

## 语义

- **三值逻辑**：每个条件求值为 `true` / `false` / `unknown`（Kleene 强三值逻辑）。
  - `and`：`false` 优先，其次 `unknown`；`or`：`true` 优先，其次 `unknown`；`not(unknown) = unknown`。
- **缺属性为未知**：请求中缺失的属性使涉及它的比较求值为 `unknown`，绝不静默当作 `false`。
- **有理数比较**：有理数以 `BigInt` 分子/分母规范化存储（`1/10 + 2/10 === 3/10` 精确成立），
  支持 `eq/ne/lt/le/gt/ge`；小数文本（如 `"0.1"`）精确解析为分数，不经过浮点。
  非有理数上的大小比较为 `unknown`；跨类型的 `eq`/`ne` 仍可判定（分别为 `false`/`true`）。
- **最终仅真允许**：只有求值为 `true` 的 allow 规则才放行；`unknown` 的 allow 规则不放行。
- **拒绝规则任一真即拒绝**：任一 deny 规则为 `true` 即拒绝（优先于 allow）。
- **未知拒绝不自动拒绝**：deny 规则为 `unknown`（如缺属性）不会导致拒绝；
  请求仍可能被为真的 allow 规则放行，否则落入默认拒绝（default deny）。

判定过程：任一 deny 为真 → `deny`；否则任一 allow 为真 → `allow`；否则 → `deny`（默认拒绝）。

## 最小决定规则集

`minimizePolicy(policy)` 贪心删除冗余规则：每删除一条规则，都用**穷举属性核对**证明
剩余规则集与原策略在所有采样点上判定一致。结果是**不可再约（irredundant）**的规则集
——未必是全局最小，但每一步删除都经过穷举验证。

穷举属性空间（适用于小策略）：

- 布尔属性 → `{true, false, 缺失}`
- 字符串属性 → `{策略中出现的字面量, 一个全新的 "other" 字符串, 缺失}`
- 有理数属性 → 策略中的阈值把有理数直线划分为若干单元，逐单元采样：
  `t0-1, 每个阈值 ti, 相邻阈值中点, tk+1, 缺失`。由于条件只与这些阈值比较，
  每个单元内判定恒定，采样即忠实穷举。

空间超过 `maxAssignments`（默认 100 000）时拒绝猜测，原样返回策略并置 `verified: false`。

## 用法

```ts
import { and, eq, ge, rational, rule, decide, minimizePolicy } from "tvl-policy";

const policy = {
  rules: [
    rule("allow-staff", "allow", and(eq("role", "staff"), ge("clearance", rational(2n)))),
    rule("deny-high-risk", "deny", ge("risk", parseRational("4/5"))),
  ],
};

decide(policy, { role: "staff", clearance: rational(3n) }); // "allow"（risk 缺失 → deny 规则未知，不自动拒绝）
decide(policy, { role: "staff" });                          // "deny"（allow 规则未知 → 默认拒绝）

const res = minimizePolicy(policy);
res.policy;   // 最小规则集
res.verified; // 是否经穷举核对
```

## 脚本

- `npm test` — 编译（`tsc`）后用 Node 内置测试运行器跑全部测试
- `npm run typecheck` — `tsc --noEmit` 严格类型检查
- `npm run demo` — 演示策略求值与最小化输出

环境要求：Node.js ≥ 18（测试运行器），TypeScript 编译器（`tsc`，仅开发期使用）。
注：本环境 Node v22.22.1 未编译进类型剥离支持（`ERR_NO_TYPESCRIPT`），
故测试前先由 `tsc` 编译到 `dist/` 再执行，不依赖任何 npm 包。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：

```
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 657.331469
```

4 个测试文件共 30 个用例全部通过（有理数 6、三值逻辑 4、策略求值 9、最小化与穷举 11）。
`npm run typecheck` 无错误。

`npm run demo` 输出（最小化 5 条规则 → 3 条，穷举 576 个属性赋值核对一致）：

```
== minimized rule set ==
policy document-access:
ALLOW allow-staff: (role eq "staff" and clearance ge 2)
DENY  deny-high-risk: risk ge 4/5
DENY  deny-suspended: suspended eq true
removed: [allow-senior-staff, allow-never]
verified by exhaustive enumeration over 576 assignments: true
```

## 结构

- `src/rational.ts` — 精确有理数（BigInt 规范化、解析、比较、中点采样）
- `src/tvl.ts` — Kleene 三值逻辑
- `src/expr.ts` — 条件表达式与三值求值
- `src/policy.ts` — 规则/策略、判定与解释
- `src/minimize.ts` — 穷举属性空间、规则集最小化与等价核对
- `test/` — `node:test` 测试；`examples/demo.ts` — 演示
- `types/node-shims.d.ts` — 离线环境下 `node:test` / `node:assert/strict` 的最小类型声明
