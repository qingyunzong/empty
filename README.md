# safetpl — 安全模板库

零依赖（仅 TypeScript + Node.js 内置模块）的微型模板引擎，默认拒绝一切危险访问。

## 语法

- `{{ expr }}` 输出表达式，支持过滤器：`{{ name | upper }}`、`{{ items | join("-") }}`
- `{% if cond %}...{% else %}...{% endif %}` 条件
- `{% for x in items %}...{% else %}...{% endfor %}` 循环（`else` 为空数组分支）
- 表达式：字符串/数字/布尔/null 字面量、点路径（`a.b.0`）、过滤器管道
- 内置过滤器：`upper` `lower` `escape` `length` `join` `json` `default`

## 安全模型

- **仅自有字段**：属性读取只接受 `Object.getOwnPropertyDescriptor` 命中的自有数据属性；
  原型链上的名字（`toString`、`hasOwnProperty`、`push`…）抛 `SecurityError`。
- **拒绝危险键**：`__proto__`、`prototype`、`constructor` 即使是自有键也一律拒绝。
- **拒绝代码执行**：getter/setter 访问器、函数值（方法）一律拒绝，getter 不会被触发。
- **步数预算**：循环迭代与过滤器调用共享 `maxSteps` 预算（默认 10000），耗尽抛
  `BudgetExceededError`。
- **原子输出**：渲染先写入内部缓冲区，任何异常都使整个渲染失败，调用方拿不到部分文本；
  `tryRender` 失败时返回 `{ ok: false, error }`，不含 `output` 字段。
- **循环检测**：路径解析链与 `json` 过滤器均检测对象循环，抛 `CycleError`
  （共享但非循环的引用不受影响）。
- **来源位置**：所有错误携带 `{ offset, line, column }`，消息含 `at line L, column C`。

## 用法

```ts
import { render, tryRender } from "./src/index";

render("Hello {{ user.name }}!", { user: { name: "amy" } }); // "Hello amy!"

const result = tryRender("{{ items | join(', ') }}", { items: [1, 2] }, { maxSteps: 100 });
if (result.ok) console.log(result.output);
else console.error(result.error.message, result.error.position);
```

## 脚本

- `npm run build` — `tsc -p tsconfig.json`（需要全局可用的 `tsc`，本项目用 TypeScript 7.0.2 验证）
- `npm test` — 编译后用 `node --test` 运行 `dist/test/*.test.js`

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`：

```
# Subtest: dist/test/atomicity.test.js   ok（异常不输出部分文本，4 例）
# Subtest: dist/test/basics.test.js      ok（基础渲染，11 例）
# Subtest: dist/test/budget.test.js      ok（循环/过滤步数预算，5 例）
# Subtest: dist/test/cycles.test.js      ok（对象循环检测，5 例）
# Subtest: dist/test/positions.test.js   ok（来源位置核对，6 例）
# Subtest: dist/test/security.test.js    ok（恶意键与原型链，11 例）
# tests 6
# pass 6
# fail 0
```

共 6 个测试文件、42 个用例，全部通过。

## 目录结构

- `src/errors.ts` — 错误类型与 `SourcePosition`
- `src/lexer.ts` — 分词（携带行列偏移）
- `src/parser.ts` — AST 与解析
- `src/secure.ts` — 自有字段读取、拒绝键、循环安全序列化
- `src/filters.ts` — 内置过滤器
- `src/runtime.ts` — 解释器：作用域、预算、原子渲染
- `test/` — `node:test` + `node:assert/strict` 验收测试
- `types/node-shim.d.ts` — Node 内置模块的最小类型声明（避免外部 @types 依赖）
