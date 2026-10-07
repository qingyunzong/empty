# safe-template

一个安全沙箱化的模板库（TypeScript + Node.js 内置库，零运行时依赖）。

## 安全模型

- **仅自有字段可读**：属性访问要求 `Object.hasOwn` 为真，原型链上的属性
  （如 `toString`、类方法、继承字段）一律拒绝。
- **危险键拒绝**：`__proto__`、`constructor`、`prototype` 即使是对象自有
  属性也拒绝访问；函数值不可插值、不可做成员访问。
- **步数预算**：循环每次迭代、每次过滤器调用各消耗 1 步，共享同一预算
  （默认 `10000`，可用 `maxSteps` 配置），超限抛 `BUDGET_EXCEEDED`。
- **原子输出**：渲染结果先写入内部缓冲区，任何异常都会中止渲染并抛出
  `TemplateError`，调用方永远拿不到部分文本；`tryRender` 的失败结果也
  不携带 `output` 字段。
- **来源位置**：所有错误携带 `{ offset, line, column }`（1 起始行列），
  指向出错的标识符、键或标签位置。

## 语法

```
{{ user.name }}                      插值（点与 [索引]/['键'] 访问）
{{ name | upper }}                   过滤器，可链式、可传字面量参数
{{#each items as item}}…{{else}}…{{/each}}   循环（仅数组）
{{#if cond}}…{{else}}…{{/if}}        条件
```

内置过滤器：`upper`、`lower`、`trim`、`length`、`join(sep)`、`default(fallback)`。

## 用法

```ts
import { render, tryRender } from './src/index.js';

render('Hello {{ user.name | upper }}!', { user: { name: 'Ada' } });
// => 'Hello ADA!'

const result = tryRender('{{ user.__proto__ }}', { user: {} });
// => { ok: false, error: TemplateError { code: 'SECURITY_ERROR', position: { offset: 8, line: 1, column: 9 } } }
```

## 测试

```sh
npm test    # tsc 编译后运行 node --test
```

## 实测结果

环境：Node.js v22.22.1，tsc 7.0.2，2026-10-08 实跑。

```
$ npm test
# tests 4   (4 个测试文件)
# pass 4
# fail 0
```

逐文件展开共 37 个用例，全部通过：

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `test/security.test.ts` | 11 | 恶意键（`__proto__`/`constructor`/`prototype`）、原型链/类方法/自有危险键、函数值、整体对象插值 |
| `test/budget.test.ts` | 6 | 循环与过滤器共享步数预算、默认预算上限、预算错误位置 |
| `test/render.test.ts` | 15 | 插值/循环/条件/过滤器、对象循环（环形引用）数据、异常无部分输出 |
| `test/positions.test.ts` | 5 | 各类错误的 offset/line/column 精确核对 |
