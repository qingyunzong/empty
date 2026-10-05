# oneof-validator

TypeScript 校验库，仅依赖 Node.js 内置模块（运行时零依赖）。支持
`object` / `array` / `integer` / `$ref` 引用 / `oneOf`，并满足：

- **oneOf 恰一分支成功才通过**：0 个分支成功报 `oneOf.none`；
  多个分支成功报 `oneOf.ambiguous`，并在 `branches` 字段返回歧义分支路径
  （如 `["#/oneOf/0", "#/oneOf/1"]`）。
- **循环引用允许，实际对象环拒绝**：schema 可通过 `$ref` 递归（如链表），
  任意深度的有限数据都可校验；数据中真实存在的对象/数组环报 `cycle` 错误。
- **错误按路径 UTF-8 字节序排序**（非 JS 默认的 UTF-16 码元序，
  对 astral 字符两者不同）。
- **与直接递归模型对照**：主引擎 `validate` 是单栈迭代状态机；
  `recursiveModel.validateRecursive` 是同一语义的直接递归实现，
  差分测试要求两者输出逐字节一致。

## Schema 形式

```ts
type Schema =
  | { type: 'integer' }
  | { type: 'object'; properties: Record<string, Schema>; required?: string[] }
  | { type: 'array'; items: Schema }
  | { $ref: string }              // 指向 definitions 中的名字
  | { oneOf: Schema[] };

interface SchemaDocument { root: Schema; definitions?: Record<string, Schema> }
```

```ts
import { validate } from './src/validate.js';

const errors = validate(data, {
  definitions: {
    List: {
      type: 'object',
      properties: { value: { type: 'integer' }, next: { $ref: 'List' } },
      required: ['value'],
    },
  },
  root: { $ref: 'List' },
});
// errors: { path, code, message, branches? }[]，按 path 的 UTF-8 字节序排列
```

## 语义要点

- 路径从 `$` 开始：属性 `.key`（非标识符用 `$["key"]`），数组 `$[0]`。
- 错误码：`type`、`required`、`oneOf.none`、`oneOf.ambiguous`、`cycle`、
  `ref.unresolved`、`ref.loop`。
- oneOf 分支内部产生的错误只决定该分支成败，不外泄；分支自身包含
  歧义 oneOf 时该分支计为失败。
- 数据环检测基于当前路径的祖先集合（进入/退出标记），因此 DAG 式的
  共享引用是合法的，只有真正的环才被拒绝。
- 纯 `$ref` 链成环（`A -> B -> A`）报 `ref.loop`；oneOf/$ref 混合的
  不退化递归（展开时不消费任何数据）会被“spine”检测截断，
  该分支计为失败，保证任何 schema 都终止。
- 主引擎为迭代式：20 万节点链表（经递归 `$ref`）可校验而不爆栈；
  递归模型受调用栈限制，仅作对照预言机。

## 命令

```sh
npm test        # tsc 编译 + node --test（Node 内置测试运行器）
npm run build   # 仅编译到 dist/
npm run typecheck
```

## 实测结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 实际输出：

```
> oneof-validator@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/differential.test.js
ok 1 - dist/test/differential.test.js
# Subtest: dist/test/validate.test.js
ok 2 - dist/test/validate.test.js
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms ~500-600
```

分文件统计（`node dist/test/<file>` 的 TAP 汇总）：

- `dist/test/validate.test.js`：tests 18，pass 18，fail 0
  （含 20 万节点递归链表、对象/数组数据环、UTF-8 字节序与 UTF-16 序
  差异的边界用例）
- `dist/test/differential.test.js`：tests 2，pass 2，fail 0
  （400 个随机种子 schema+数据（含注入数据环）与递归模型逐字节一致；
  500 层深递归数据两引擎一致）

`npm run typecheck`（`tsc --noEmit`，strict 模式）：无错误。
