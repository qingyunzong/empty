# form-visibility-fixpoint

表单字段可见性库：可见条件为字段值上的布尔表达式，隐藏字段视为未填写，
通过**从全隐藏开始的单调固定点迭代**解析（含循环依赖），并在模式校验期
**拒绝含非单调隐藏引用的条件**。整批值更新原子计算，输出每轮变化，并可
与有限真值表核验。

## 运行

```sh
npm test   # tsc 编译 + node --test 执行全部测试
```

## 表达式语言（`src/expr.ts`）

| 构造 | 语义（隐藏 = 未填写 = `undefined`） | 单调性 |
| --- | --- | --- |
| `E.const(b)` | 常量 | 单调 |
| `E.filled(f)` | `f` 可见且有值 | 单调 |
| `E.value(f)` | `f` 可见且值为真 | 单调 |
| `E.eq(f, v)` | `f` 可见且值 `=== v` | 单调 |
| `E.cmp(op, f, n)` | `f` 可见且数值比较成立 | 单调 |
| `E.and(...) / E.or(...)` | 子表达式均单调时单调 | 保持 |
| `E.not(x)` | 仅允许包裹与可见性无关的子表达式 | 受限 |
| `E.neq(f, v)` | 隐藏时为真、可见后可能翻假 | **拒绝** |

`compileSchema` 在编译期做结构单调性检查，含非单调隐藏引用
（如 `not(filled(x))`、`neq`）的条件抛出 `NonMonotoneConditionError`。

## 固定点计算（`src/form.ts`）

`computeVisibility(schema, values)` 从全隐藏赋值开始 Jacobi 迭代：每轮以上
一轮快照求值所有仍隐藏字段的条件，本轮新满足的字段整轮一次性加入。单调
性保证 ≤ n 轮收敛到唯一最小不动点，且每轮变化与字段顺序无关。返回
`{ visible, hidden, rounds }`，`rounds` 记录每轮新可见的字段。

`applyBatch(schema, previous, updates)` 先合成完整新值表，再从全隐藏重算
一次固定点——整批更新原子生效，无中间态；返回每轮变化及相对上一状态的
`becameVisible` / `becameHidden` 差异。

## 真值表核验（`src/truth.ts`）

`verifyWithTruthTable(schema, values)` 枚举全部 2^n 个可见性赋值，找出所有
不动点，断言迭代结果是不动点且是包含序下的最小者。测试对手工模式、互递归
多不动点模式，以及随机单调模式 × 有限值域（`{undefined,0,1,true,false}`）
的全组合做穷举核验。

## 示例

```ts
import { E, applyBatch } from "./src";

const schema = {
  fields: [
    { name: "p", when: E.const(true) },
    { name: "q", when: E.eq("p", "on") },
    { name: "r", when: E.eq("q", "yes") },
  ],
};

const res = applyBatch(schema, null, { p: "on", q: "yes" });
// res.visible = ["p", "q", "r"]
// res.rounds  = [{round:1,becameVisible:["p"]},
//                {round:2,becameVisible:["q"]},
//                {round:3,becameVisible:["r"]}]
```
