# min-cost-tree-parse

有限正则树文法（finite regular tree grammar）的最低费用解析库。TypeScript 编写，
运行时仅使用 Node.js 内置模块（`node:test` / `node:assert`，仅测试使用），无任何第三方依赖。

## 问题建模

- **文法**：秩字母表 `arity: symbol -> 元数`、非终结符集、起始非终结符、规则集。
  每条规则形如 `A -> f(B1, ..., Bn)`（`n = arity(f)`），携带**非负费用** `cost`。
  **允许递归规则**（`A` 可出现在自身规则的子节点中）。
- **输入序列**：输入树的前序（波兰式）序列化，如 `g f a b` 配合元数表唯一解码
  （`decodeSequence`）。畸形序列（未知符号、截断、多余 token）抛 `SequenceError`，
  与"不可行"严格区分。
- **求解**：对输入树自底向上 DP——`dp[节点][A] = min_{规则 A->f(B1..Bn)} cost + Σ dp[子k][Bk]`。
  输入树有限，递归规则无需不动点迭代，自底向上顺序天然处理。
  复杂度 `O(节点数 × 规则数)`。

## 结果三态（不可行 vs 超预算）

`parseSequence` / `parseTree` 返回 `ParseResult`：

| `status`       | 含义                                             | `cost` / `certificate` |
| -------------- | ------------------------------------------------ | ---------------------- |
| `"optimal"`    | 存在最省推导且费用 ≤ 预算（或未给预算）          | 均给出                 |
| `"over-budget"`| 推导存在，但最省费用 > 预算（非不可行！）        | 均给出（作为证据）     |
| `"infeasible"` | 输入根本不存在任何推导                           | 均为 `null`            |

## 推导证书

`certificate = { ruleIds, cost }`：输入树节点**先序**对应的规则 ID 序列及总费用。
`verifyCertificate(grammar, tree, cert)` 独立重放校验：规则 ID 存在、符号与节点标签匹配、
子非终结符衔接、根为起始符、ID 序列恰好耗尽、费用和等于声明值。

## 穷举核对（小文法有界树）

- `bruteForceMinCost(grammar, tree, maxRuns)`：不使用 DP，穷举输入树上的**所有**推导
  （run）取最小费用，指数级，仅供小规模核对。
- `enumerateTrees(grammar, maxDepth, cap)`：枚举文法在深度界内可推导的全部树（去重）。
- 测试 `test/crosscheck.test.ts`：400 个随机小文法 × 随机输入树上 DP 与穷举费用逐一相等
  （含不可行一致性、证书可校验、规则 ID 数 = 节点数）；另对两个手工文法枚举深度 ≤ 3 的
  全部派生树，验证每棵树均为 `optimal`、费用与穷举一致、证书通过校验。

## 用法

```ts
import { parseSequence, verifyCertificate } from "./src/index.ts";

const grammar = {
  arity: { a: 0, f: 1 },
  nonterminals: ["S"],
  start: "S",
  rules: [
    { id: 0, lhs: "S", symbol: "f", children: ["S"], cost: 2 }, // 递归规则
    { id: 1, lhs: "S", symbol: "a", children: [], cost: 5 },
  ],
};

const result = parseSequence(grammar, ["f", "f", "a"], { budget: 10 });
// result.status === "optimal", result.cost === 9
// result.certificate.ruleIds === [0, 0, 1]
verifyCertificate(grammar, result.tree, result.certificate); // { ok: true }
```

## 脚本

- `npm test`：`tsc -p tsconfig.build.json` 编译到 `out/` 后运行 `node --test out/test/*.test.js`
- `npm run typecheck`：`tsc --noEmit` 严格类型检查

注：本机 Node v22.22.1 未内建 TypeScript 类型擦除支持，故测试前先用全局 `tsc`（7.0.2）
编译；运行产物仅依赖 Node 内置模块。

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
$ npm test
ok 1 - out/test/certificate.test.js   (7 个用例：真证书通过；篡改费用/乱序/截断/多余/未知 ID/错配输入均被拒)
ok 2 - out/test/crosscheck.test.js    (3 个用例：400 随机实例 DP==穷举；预算不改变可行性；有界树枚举全量核对)
ok 3 - out/test/grammar.test.js       (6 个用例：文法校验)
ok 4 - out/test/parse.test.js         (9 个用例：歧义取最省、递归费用累加、三态区分、零费用、序列/树 API 一致)
ok 5 - out/test/sequence.test.js      (5 个用例：前序序列编解码与畸形输入)
# tests 5   # pass 5   # fail 0        （共 30 个测试用例，全部通过）

$ npm run typecheck                    （tsc --noEmit，strict，通过）
```
