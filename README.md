# peg-cut

PEG 语法组合子库（TypeScript，仅依赖 Node.js 内置模块），支持：

- **序列** `seq(...)`、**优先选择** `alt(...)`（有序选择，先匹配者优先，不回溯）
- **重复** `rep(p)`（零次或多次）、`opt(p)`、`eps()`、`eof()`
- **显式 cut** `cut()`：cut 之后若失败，不再尝试所属选择分支的后备分支
- **记忆化**（packrat）：以 (规则, 位置) 为缓存单位，且不混淆 cut 作用域
- **最远失败报告**：解析失败时输出最远失败位置及该位置的期望终结符集合
- **对照测试**：记忆化解释器与无缓存解释器在随机文法和手工文法上逐输入比对

## 快速开始

```sh
npm test   # tsc 编译 + node --test（需要全局可用的 tsc）
```

## 示例

```ts
import { alt, cut, grammar, lit, parse, ref, rep, seq } from './src/peg.js';

const expr = grammar(
  {
    E: alt(seq(ref('T'), lit('+'), cut(), ref('E')), ref('T')),
    T: alt(seq(ref('F'), lit('*'), cut(), ref('T')), ref('F')),
    F: alt(seq(lit('('), cut(), ref('E'), lit(')')), lit('a'), lit('b')),
  },
  'E',
);

parse(expr, 'a+b*a');   // { ok: true, value: ... }
parse(expr, 'a+*b');    // { ok: false, error: { pos: 2, expected: ['"("', '"a"', '"b"'] } }
parse(expr, 'a+b', { memo: false });  // 无缓存解释器，行为完全一致
```

## 语义要点

### cut 的作用域

cut 提交到**动态最近的外层选择**。一旦 cut 被消费，之后在该分支内的失败
不再尝试该选择的其余分支；该选择吸收这次 cut——它对外层产生的失败
（或成功）又是普通的，外层选择仍可尝试其它分支。cut 可以穿过 `rep`
的重复体向外传播。

### 记忆化与 cut

每个解析结果都携带 `cut` 标志（"产生该结果期间消费了尚未被任何选择
吸收的 cut"）。缓存条目同时保存结果与 `cut` 标志，缓存命中时原样回放，
因此命中与重新求值的行为完全一致，cut 作用域不会被缓存混淆
（见 `test/peg.test.ts` 中 "memoization preserves cut scope across cache
hits" 用例：朴素缓存会错误地接受输入 `"ac"`）。

### 最远失败集合

终结符失败时向上下文记录 (位置, 期望)。缓存条目还保存求值期间产生的
失败记录，命中时回放，保证记忆化与无缓存解释器输出完全相同的最远失败
集合。

### 语法错误

以下情况抛出 `GrammarError`（属于语法定义错误，而非解析失败）：

- `rep` 的重复体不消耗输入即成功（零消费重复，否则会死循环）
- 左递归（记忆化与无缓存模式都会检测）
- 引用未定义规则、空 `lit('')`、空 `alt()`

## 项目结构

- `src/peg.ts` — 库本体（组合子 + 解释器 + 记忆化）
- `test/peg.test.ts` — 14 个单元测试（cut 语义、作用域、零消费、最远失败、缓存命中）
- `test/differential.test.ts` — 对照测试：400 个随机文法 × 8 个随机输入
  （共 3200 例）+ 5 个手工文法（含 cut、递归、左递归、零消费）× 400 个
  随机输入（共 2000 例），逐一断言记忆化与无缓存结果一致
- `types/node-shim.d.ts` — 离线环境下 `node:test` / `node:assert` 的最小类型声明

## 实际测试结果

`npm test`（Node.js v22.22.1，tsc 编译后由 `node --test` 运行）实际输出：

```
# Subtest: dist/test/differential.test.js
ok 1 - dist/test/differential.test.js
# Subtest: dist/test/peg.test.js
ok 2 - dist/test/peg.test.js
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 266.272461
```

其中 `dist/test/peg.test.js` 含 14 个单元测试全部通过，
`dist/test/differential.test.js` 含 2 个对照测试（5200 个比对用例，
且断言了缓存确实被命中）全部通过。
