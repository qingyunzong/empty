# expr-destructure

一个小型 TypeScript 表达式库，支持嵌套数组/对象模式的解构赋值，语义为**两阶段提交**：

1. **求值阶段**：右值表达式只求值一次；随后按模式顺序（从左到右、深度优先）读取属性/元素并求值默认表达式，全部结果先收集到待定绑定列表。
2. **提交阶段**：按模式顺序统一写入所有绑定。

求值阶段任一步失败（右值抛错、默认表达式抛错、结构不匹配、引用未定义），**不写入任何绑定**（原子性）。

默认值仅对 missing（`undefined`）生效；`null` 原样保留（匹配到 `null` 时不触发默认值，若模式要求对象/数组则抛 `TypeError`）。

## 结构

- `src/expr.ts` — 表达式 AST（`lit` / `ref` / `get` / `call` / `arr` / `obj`）与求值器
- `src/pattern.ts` — 模式 AST（`id` / `arrPat` / `objPat` / `withDefault`，支持空位与 rest）
- `src/scope.ts` — 变量环境，读写经 `onRead` / `onWrite` 钩子，便于用副作用日志核验求值顺序
- `src/destructure.ts` — `destructureAssign(scope, pattern, rhs)`，两阶段解构赋值

## 示例

```ts
const scope = new Scope({ a: 100 });
destructureAssign(
  scope,
  objPat({ a: id('a'), b: id('b', ref('a')) }), // { a, b = a }
  lit({ a: 1 }),
);
scope.get('a'); // 1
scope.get('b'); // 100 —— 默认值读到的是写入前的旧绑定
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行 dist/test
```

测试通过带副作用的引用（`Scope` 读写钩子 + 会写日志的函数）核验：右值先求值且仅一次、默认值按模式顺序求值、所有写入发生在最后；并覆盖默认值仅对 missing 生效、`null` 保留、以及各类失败路径下的原子性。
