# mincost-tree-parse

有限树文法（带非负费用的加权上下文无关文法）的**最低费用解析**库。
TypeScript 编写，运行时只依赖 Node.js 内置模块（`node:test` / `node:assert`），
零 npm 依赖。允许递归规则（含零费用环），输出最低费用解析树与规则 ID 序列，
给出可独立核验的推导证书，并附小文法有界穷举核对器。

## 问题模型

- 文法：`{ start, rules: [{ id, lhs, rhs, cost }] }`
  - `lhs` 为非终结符；`rhs` 为符号序列（空数组 = ε 规则）。
  - 出现在任意 `lhs` 中的符号为非终结符，其余 `rhs` 符号为终结符。
  - `cost` 为非负有限数；递归规则（直接或间接）允许。
- 输入：终结符序列（token 数组）。
- 求解：从 `start` 推导该序列的**最低总费用**解析树，并列出推导的规则 ID 序
  （树的前序 = 最左推导）。

## 结果状态（不可行 vs 预算）

求解器是精确的，因此三种情形严格区分，不存在"预算未知"：

| 状态          | 含义                                             |
| ------------- | ------------------------------------------------ |
| `optimal`     | 找到最低费用解析（若给预算则 `cost <= budget`）  |
| `over-budget` | 序列可解析，但最低费用超过给定预算（附最优解）   |
| `infeasible`  | 序列**根本不可推导**（与预算无关，结论精确）     |

## 算法

项 `(A, i, j)` 表示"非终结符 `A` 推导子序列 `s[i..j)`"。在推导超图上做
Bellman-Ford 式混沌松弛（不动点迭代）：规则 `A → X1..Xk`（费用 c）产生候选
费用 `c + Σ 子项费用`。因费用非负，最优推导树的根到叶路径上不必重复任何项
（重复项之间的环费用非负，可删除而不增费），故深度 ≤ 项数即完备，迭代在
项数 + 2 轮内保证收敛。回溯指针图无环（每条边由严格改进安装），可安全重建
一棵最优树。不可行性因此是可判定的精确结论。

## API

```ts
import { parse, verifyCertificate, enumerateParses, completenessBound } from './src/index';

const res = parse(grammar, sequence, { budget: 10 }); // budget 可省略
if (res.status !== 'infeasible') {
  res.cost;      // 最低费用
  res.tree;      // 解析树（节点含 ruleId/symbol/children）
  res.ruleIds;   // 规则 ID 序（前序 = 最左推导）
  res.certificate; // 推导证书
  verifyCertificate(grammar, res.certificate); // { ok: true } | { ok: false, reason }
}
```

- `verifyCertificate(grammar, cert)`：独立核验证书——树结构符合规则、
  叶产出等于序列、`ruleIds` 等于最左推导、费用等于规则费用之和。
- `enumerateParses(grammar, seq, maxDepth, cap)`：穷举深度 ≤ `maxDepth` 的
  全部解析树（测试 oracle）；`completenessBound` 给出完备深度界（项数）。

## 构建与测试

```sh
npm test   # tsc 编译 + node --test 运行全部测试
npm run demo
```

## 实测结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 实际输出：

```
✔ dist/test/certificate.test.js (380.5ms)
✔ dist/test/exhaustive.test.js (1127.1ms)
✔ dist/test/parse.test.js (369.8ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ duration_ms 1161.6
```

其中随机对拍测试实际输出：

```
cross-checked 300 random grammars (285 infeasible), 303 attempts
```

即 300 个随机小文法（2–4 个非终结符、含递归/ε/零费用规则、序列长 0–6）上，
DP 最优费用与有界穷举 oracle 完全一致，且每个证书均通过独立核验。

`npm run demo` 实际输出：

```
status        : over-budget
min cost      : 3
rule id seq   : 2 1 4 4 4
certificate ok: true
infeasible ex : infeasible
oracle min    : 3 (over 2 trees, depth<=21)
```

## 目录

- `src/grammar.ts` — 文法类型、校验与编译（终结符/非终结符解析）
- `src/parse.ts` — 最低费用解析器（不动点 DP + 回溯指针重建）
- `src/certificate.ts` — 推导证书类型与独立验证器
- `src/enumerate.ts` — 有界穷举 oracle 与完备深度界
- `src/tree.ts` — 解析树类型与前序规则 ID、产出、费用、深度
- `test/` — 功能测试、证书篡改测试、随机文法 DP vs 穷举对拍
- `types/node-shims.d.ts` — 零依赖下 `node:test`/`node:assert` 的最小类型声明
