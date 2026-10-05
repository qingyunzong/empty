# mail-template

邮件模板库：支持变量、条件、循环；替换内容**不再递归解释**；输出带**逐字符来源映射**（模板 / 变量）；嵌套错误带**原文范围**；展开字数受限时**整次失败**；附带一个独立的小型模板解释器用于**核对映射**。

仅使用 TypeScript + Node.js 内置库（`node:test`、`node:assert`），无任何运行时依赖。

## 模板语法

| 语法 | 含义 |
| --- | --- |
| `{{ user.name }}` | 变量插值（支持点路径、`this`、`@index`） |
| `{{#if cond}}...{{else}}...{{/if}}` | 条件（`0`、`''`、`null`、空数组为假） |
| `{{#each items}}...{{/each}}` | 循环（`this` 为当前元素，`@index` 为下标；`null` 视为空） |
| `{{! comment }}` | 注释，不输出 |

规则：

- **替换内容不再递归解释**：变量值即使包含 `{{...}}` 也按字面输出，绝不二次解析。
- 变量未定义、对非数组值循环、插值对象/数组都会抛出 `RenderError`（带标签原文范围）。
- 循环内裸变量名按作用域链向外查找（当前元素 → 外层 → 根数据）。

## API

```ts
import { render, interpret } from './src/index.js';

const result = render('Hi {{name}}!', { name: 'Bo' });
result.output;    // 'Hi Bo!'
result.segments;  // 见下方来源映射

render(tpl, data, { maxOutputLength: 1000 }); // 超限抛 ExpansionLimitError，整次失败
```

### 来源映射（逐字符）

`segments` 按输出顺序拼接即为 `output`，每段的 `source` 标明来源，因此每个输出字符都能回溯：

- `{ kind: 'template', start, end }`：来自模板原文 `[start, end)`；
- `{ kind: 'variable', path, start, end }`：来自变量值，`path` 为解析后的完整路径（如 `items[2].name`），`[start, end)` 为值内偏移。

### 错误范围

`TemplateSyntaxError` / `RenderError` 携带 `start`、`end`、`line`、`column`、`snippet`（原文片段）；标签不匹配时另带 `related`，指向对应开标签的范围。

### 展开上限（全次失败）

`maxOutputLength` 超出时抛出 `ExpansionLimitError`，本次渲染不返回任何部分结果（全或无）。

### 核对解释器

`interpret(template, data, maxOutputLength?)` 是一个独立实现的小型解释器（不建 AST、按原文区间递归求值），测试中用它交叉核对：

1. `render(...).output === interpret(...)`（固定用例 + 300 个生成用例）；
2. 分段文本拼接等于解释器输出；
3. 模板分段与模板切片一致、且不与任何标签区间重叠；
4. 变量分段与按解析路径独立求值得到的值切片一致；
5. 超限行为两者一致（同时抛 `ExpansionLimitError`）。

## 运行测试

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 运行
```

## 实际测试结果

环境：Node.js v22.22.1，tsc 7.0.2，2026-10-06 实测。

```
ok 1 - dist/test/crosscheck.test.js    # tests 3  pass 3
ok 2 - dist/test/errors.test.js        # tests 9  pass 9
ok 3 - dist/test/limit.test.js         # tests 4  pass 4
ok 4 - dist/test/provenance.test.js    # tests 5  pass 5
ok 5 - dist/test/render.test.js        # tests 13 pass 13
# tests 5   (文件级)
# pass 5
# fail 0
```

合计 34 个断言用例全部通过，0 失败。
