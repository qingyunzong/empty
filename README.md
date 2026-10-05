# tri-policy

三值逻辑策略库：Kleene 三值布尔逻辑 + BigInt 精确有理数比较，仅使用 Node.js 内置模块
（`node:test` / `node:assert`），TypeScript 编写，`tsc` 编译后运行，零运行时依赖。

## 语义

- **三值逻辑**：`T` / `F` / `U`（未知）。Kleene 真值表：`and` 中 `F` 优先、其次 `U`；
  `or` 中 `T` 优先、其次 `U`；`not U = U`。
- **缺属性即未知**：引用不存在的属性得到 `U`，沿表达式按三值逻辑传播。
- **有理数比较**：`Rational` 以 BigInt 分子/分母存储并恒约分，比较精确
  （`1/3` 与 `0.333...` 不会混淆）；数字字面量经十进制字符串转换，`0.1` 即 `1/10`。
  布尔与有理数混合比较、布尔的大小比较均为 `U`。
- **决定聚合**（`decide`）：
  1. 任一 deny 规则为 `T` → 拒绝；
  2. 否则某条 permit 规则为 `T` → 允许（permit 为 `U`/`F` 不允许）；
  3. 否则默认拒绝。
  即：未知拒绝不自动拒绝，最终仅真允许。
- **最小决定规则集**（`minimalDecisiveSet`）：最小的规则子集，使得仅固定这些规则的
  求值结果，其余规则无论取 `T`/`F`/`U`，最终决定不变：
  - 无 permit 规则 → 空集（决定必为拒绝）；
  - 因真 deny 规则而拒绝 → 该规则单例；
  - 允许 → 一条为真的 permit 见证规则 + 全部 deny 规则（每条未核对的 deny 都可能翻盘）；
  - 默认拒绝 → 全部 permit 规则（每条未核对的 permit 都可能为真）。

## 穷举核对

`verifyPolicyExhaustive(policy, domains)` 对小策略穷举全部属性赋值（每个属性取
候选值 + 缺失），对每种赋值核对：求值可全函数且确定、决定与聚合语义一致、
返回的决定规则集经补集 `3^n` 暴力验证确实"决定"结果、且其基数等于暴力搜出的最小值。

## 使用

```bash
npm test    # tsc 编译 + node --test
npm run demo
```

```ts
import { and, attr, cmp, lit } from './src/expr.js';
import { evaluate } from './src/policy.js';
import { Rational } from './src/rational.js';

const policy = {
  rules: [
    { id: 'p1', effect: 'permit', when: and(cmp('ge', attr('age'), lit(18)),
                                            cmp('ge', attr('balance'), lit('3/2'))) },
    { id: 'd1', effect: 'deny',  when: cmp('lt', attr('age'), lit(18)) },
  ],
} as const;

evaluate(policy, { age: Rational.of(25), balance: Rational.parse('7/4') });
// { decision: 'permit', decisiveRuleIds: ['p1', 'd1'], ... }
```

## 实测结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
> tri-policy@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

# Subtest: dist/test/policy.test.js   ok  (10 个用例全过)
# Subtest: dist/test/rational.test.js ok  ( 6 个用例全过)
# Subtest: dist/test/trilean.test.js  ok  ( 4 个用例全过)
# Subtest: dist/test/verify.test.js   ok  ( 6 个用例全过)
# tests 4 / pass 4 / fail 0   —— 合计 26 个断言用例全部通过
```

`npm run demo` 输出：

```
case: adult solvent
  decision:          permit
  rule results:      p-solvent-adult=T p-vip=F d-minor=F d-overdrawn=F
  minimal decisive:  [p-solvent-adult, d-minor, d-overdrawn]
case: vip, balance missing
  decision:          permit
  rule results:      p-solvent-adult=U p-vip=T d-minor=F d-overdrawn=U
  minimal decisive:  [p-vip, d-minor, d-overdrawn]
case: minor
  decision:          deny
  rule results:      p-solvent-adult=F p-vip=T d-minor=T d-overdrawn=F
  minimal decisive:  [d-minor]
case: everything missing
  decision:          deny
  rule results:      p-solvent-adult=U p-vip=U d-minor=U d-overdrawn=U
  minimal decisive:  [p-solvent-adult, p-vip]
exhaustive check: 48 assignments, no failures
```

## 结构

- `src/trilean.ts` — 三值逻辑真值运算
- `src/rational.ts` — BigInt 有理数（解析、约分、比较）
- `src/expr.ts` — 表达式（属性/字面量/比较/布尔连接词）与求值
- `src/policy.ts` — 规则、决定聚合、最小决定规则集
- `src/verify.ts` — 小策略穷举核对（赋值枚举 + 决定性暴力验证）
- `test/` — `node:test` 测试；`examples/demo.ts` — 演示
- `types/node-shim.d.ts` — 环境无 `@types/node`，仅声明用到的内置模块接口
