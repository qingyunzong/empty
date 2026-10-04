# scoped-rename

一个带块作用域的源码重命名工具库（TypeScript，仅依赖 Node.js 内置模块，零外部依赖）。
对声明与引用做词法作用域解析，重命名只改写**解析到指定声明**的引用；若新名字会造成
捕获（capture），则**整次拒绝**，不产出任何编辑。输出为字节编辑计划（byte-edit plan）。

## 语言

内置一个小型类 JS 语言（`src/parser.ts` 中有完整文法）：

- 声明：`let` / `var` / `const` 与 `function name(params) { ... }`
- 块：`{ ... }`，表达式语句、`return`、赋值、二元运算、函数调用
- 注释：`//` 与 `/* */`

## 作用域规则（明确约定）

- 每个块、每个函数体以及顶层各引入一个作用域；函数参数声明在函数作用域内。
- **整块可见（use-before-define）**：声明在其整个外层块内可见，包括声明语句
  文本位置**之前**的引用。实现方式是绑定器先把块内所有声明提升（hoist），再解析引用。
- **嵌套遮蔽（shadowing）**：内层块的同名声明遮蔽外层声明，内层块中的引用解析到内层声明。

## 重命名语义

`planRename(source, position, newName)`：

- `position` 是标识符上的字节偏移，可落在声明名或任一引用上（引用会解析到其声明）。
- 只重命名解析到该声明的引用；嵌套块中遮蔽它的同名声明及其引用**不受影响**。
- 以下情况**整次拒绝**（返回 `{ ok: false, code, message }`，不产出任何编辑）：
  - `capture`（a）：目标的某个引用与目标声明之间存在 `newName` 的介入声明，
    改名后该引用会被窃取；
  - `capture`（b）：程序中已存在拼写为 `newName` 的引用（解析到别的声明，或当前
    未解析），改名后它会突然解析到被改名的声明；
  - `conflict`：目标声明所在的块已经声明了 `newName`；
  - `invalid-new-name` / `no-identifier-at-position` / `unresolved-identifier` /
    `parse-error`。

## 字节编辑计划

成功时返回：

```ts
{
  ok: true,
  oldName: string,
  newName: string,
  declarationSpan: { start: number, end: number },
  occurrences: number,          // 声明 + 引用 的总处数
  edits: Edit[],                // 按 start 升序、互不重叠
}
// Edit = { start: number, end: number, newText: string }
```

`edits` 覆盖声明名与所有解析到它的引用的字节区间（UTF-16 码元偏移，`[start, end)`）。
`applyEdits(source, edits)` 从后往前应用编辑并校验不重叠。

## 用法

```ts
import { planRename, applyEdits } from "./src/index.js";

const src = "let total = 1;\ntotal = total + 2;\n";
const plan = planRename(src, src.indexOf("total"), "sum");
if (plan.ok) {
  console.log(plan.edits);
  // [ { start: 4, end: 9, newText: "sum" },
  //   { start: 15, end: 20, newText: "sum" },
  //   { start: 23, end: 28, newText: "sum" } ]
  console.log(applyEdits(src, plan.edits));
  // let sum = 1;
  // sum = sum + 2;
}
```

## 项目结构

- `src/lexer.ts` — 词法分析（标识符/关键字/数字/字符串/标点，注释与空白跳过）
- `src/ast.ts` — AST 节点定义（均带字节区间）
- `src/parser.ts` — 递归下降解析器
- `src/binder.ts` — 作用域树构建、声明提升（整块可见）、引用解析
- `src/rename.ts` — 重命名规划、捕获检测、字节编辑计划与 `applyEdits`
- `src/index.ts` — 公共导出
- `test/rename.test.ts` — 测试（`node:test` + `node:assert`）
- `types/node-shims.d.ts` — `node:test` / `node:assert` 的最小类型声明（避免外部依赖）

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
# tests 25
# suites 7
# pass 25
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 57.576419
```

7 个测试套件全部通过：basic rename(4)、nested shadowing(3)、
block-wide visibility / use-before-define(2)、capture rejection(5)、
functions and parameters(3)、invalid input(5)、applyEdits(3)。
