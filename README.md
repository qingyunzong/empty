# rule-engine

规则表达式解析与求值库（TypeScript，零依赖）。

## 语法

- 逻辑：`&&`、`||`、`!`，括号 `()` 改变优先级（`!` > `&&` > `||`）
- 比较：`==`、`!=`、`<`、`<=`、`>`、`>=`（不支持链式比较）
- 字面量：整数（解析为 `bigint`，可写 `123` 或 `123n`）、字符串（`'...'` / `"..."`）、`true` / `false` / `null`
- 字段：标识符，支持点分路径如 `user.age`

## 语义

- `&&` / `||` 短路求值：未访问的字段不会触发解析器/报错
- `null` 只允许 `==` / `!=`，与 `null` 做大小比较抛 `RuleEvaluationError`
- 逻辑运算的操作数必须是布尔值；数值一律为 `bigint`
- 语法错误抛 `RuleSyntaxError`，`pos` 为 UTF-8 字节位置

## 用法

```ts
import { run, parseRule, evaluate } from "./src/index.js";

const { value, reads } = run("age >= 18 && (vip || score > 100)", {
  age: 30n,
  vip: true,
  // score 因短路未被读取，缺失也不报错
});
// value === true, reads === ["age", "vip"]
```

`run` / `evaluate` 返回 `{ value, reads }`，其中 `reads` 为实际读取的字段名（按读取顺序）。
字段也可传函数 `(name) => value` 自定义解析。`parseRule` 返回带字节位置的 AST，可复用于多次 `evaluate`。

## 测试

```sh
npm test   # tsc 编译 + node:test 运行（含 AST 参考核验）
```

需要全局可用的 `tsc`（TypeScript）。
