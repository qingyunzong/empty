# rule-engine

规则表达式引擎（TypeScript）：解析 `&&`、`||`、`!`、比较运算与括号，逻辑短路求值，数值为 bigint。

## 使用

```ts
import { run, parse, evaluate } from './src/index.js';

// 一步：解析 + 求值
const { result, reads } = run('age >= 18 && city == "sh" || vip', {
  age: 20n,        // 数值用 bigint；整数 number 会自动转换
  city: 'sh',
  vip: false,
});
// result === true
// reads === ['age', 'city']   ← 实际读取的字段及顺序；vip 被短路未读取

// 或先解析成 AST 再多次求值
const ast = parse('x != null && x > 10');
evaluate(ast, { x: 42n });
```

## 语法

```
or      := and ( '||' and )*
and     := unary ( '&&' unary )*
unary   := '!' unary | cmp          // ! 作用于其后的整个比较表达式
cmp     := primary ( cmpOp primary )?   // 不允许连续比较（a < b < c 报错）
primary := '(' or ')' | 整数 | '字符串' | "字符串" | true | false | null | 字段名
```

- 比较运算符：`==` `!=` `<` `<=` `>` `>=`
- 字段名：`[A-Za-z_][A-Za-z0-9_.]*`
- 数值只支持整数，解析为 `bigint`；小数是语法错误

## 语义

- **短路**：`&&` 左侧为假、`||` 左侧为真时，右侧不求值——未访问的字段不读取、不校验、不报错（字段不存在也不抛错）。
- **读取顺序**：返回值 `reads` 按实际读取顺序记录字段名（含重复读取）。
- **空值**：`null` 只允许 `==` / `!=`；对 `null` 用 `<` 等排序比较抛 `RuleEvalError`（kind: `'null-ordering'`）。
- **类型**：排序比较要求两侧同类型；跨类型的 `==` 为假、`!=` 为真（不报错）；布尔只允许等号比较。
- **结果**：规则整体必须求值为布尔值，否则抛 `not-boolean` 错误。

## 错误

- `RuleSyntaxError`：语法错误，`bytePos` 为源串中的 **UTF-8 字节偏移**（多字节字符按字节计）。
- `RuleEvalError`：求值错误，`kind` 为 `'unknown-field' | 'null-ordering' | 'type-mismatch' | 'not-boolean'`，`bytePos` 指向触发错误的 AST 节点。

## 测试

```sh
npm test   # tsc 编译 + node --test
```

- `test/ast.test.ts`：AST 参考核验——手写参考 AST（含字节位置）与解析结果深度比对。
- `test/eval.test.ts`：短路、读取顺序、null 限制、bigint 精度等求值语义。
- `test/errors.test.ts`：语法/求值错误的类型、kind 与字节位置。
