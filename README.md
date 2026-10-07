# destructure-expr

一个 TypeScript 表达式库，支持嵌套数组/对象模式解构，语义如下：

1. **先求值，后绑定**：先求源表达式，再按模式顺序（深度优先、从左到右）
   读取属性并求所有默认表达式，全部成功后才统一写入绑定。
2. **原子性**：任一步骤失败（源表达式报错、getter 抛错、默认表达式引用未定义
   变量、对 `null`/`undefined`/非数组值做模式匹配等），不写入任何绑定。
3. **默认值只对 missing 生效**：属性缺失或值为 `undefined` 时才求默认表达式；
   `null` 会被原样保留，不触发默认值。

## 求值顺序核验

`Env` 维护一个 `trace` 日志：`read:*`（引用读取）、`eval:*`（带副作用表达式）、
`write:*`（绑定写入）。测试用带副作用的引用（`ref` / `effect` / getter）断言
所有 `read:`/`eval:` 都先于任何 `write:` 出现。

## 示例

```ts
import { Env, ref, effect, id, arr, obj, def, destructure } from './src/index.ts';

const env = Env.from({ src: { p: [undefined, 5] } });

destructure(
  obj({
    p: arr([def(id('x'), effect('dx', 1)), id('y')]),
    q: def(obj({ r: def(id('z'), effect('dz', 2)) }), effect('dq', {})),
  }),
  ref('src'),
  env,
);

// env.trace === ['read:src', 'eval:dx', 'eval:dq', 'eval:dz',
//                'write:x', 'write:y', 'write:z']
```

## API

- 表达式：`lit(value)`、`ref(name)`、`effect(label, value)`，`evalExpr` 求值。
- 模式：`id(name)`、`arr(elements, rest?)`（`null` 为空位）、
  `obj(props, rest?)`、`def(pattern, defaultExpr)`。
- 执行：`destructure(pattern, sourceExpr, env)`。

## 脚本

- `npm test`：编译到 `dist/` 并运行 `node:test` 测试。
- `npm run typecheck`：`tsc --noEmit` 严格类型检查。
