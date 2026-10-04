# scoped-rename

一个面向源码的块级作用域重命名工具库。输入源码、目标位置和新名字，输出一份
**字节编辑计划**（不直接改写源码）；只有解析到目标声明的引用才会被改写，
一旦新名字造成捕获（capture），**整次重命名被拒绝**，不产生任何编辑。

仅使用 TypeScript + Node.js 内置库，无任何第三方运行时依赖。

## 作用域规则

- `let` / `const`、函数声明均为**块级作用域**；每个 `{ ... }` 块、函数体、
  `for` / `for...of` 头部都引入新作用域。
- **嵌套遮蔽**：内层块中的同名声明在内层块范围内遮蔽外层声明；重命名只影响
  解析到目标声明的那一层绑定。
- **先用后定义 = 整块可见**：块级声明对其**整个块**可见，包括在声明语句之前
  出现的引用（与 JS 的静态作用域一致；TDZ 只是运行时行为，不影响静态解析）。
  因此 `use-before-define` 的引用同样解析到本块声明并参与重命名。
- 函数参数位于包裹函数体块的作用域中；对象字面量键、成员访问属性名
  （`obj.x` 中的 `x`）不是引用，永不参与重命名。

## 重命名语义

`planRename(source, offset, newName)`：

1. `offset` 是 UTF-8 **字节偏移**，指向目标声明名或它的任意一个引用。
2. 解析整份源码，定位该位置标识符解析到的声明。
3. 收集该声明的名字出现位置 + 所有解析到它的引用，生成编辑计划。
4. **捕获检测**：先把新名字临时应用到作用域树上，重新解析全部引用，要求
   每个引用的绑定保持不变。以下任一情形都视为捕获，**整次拒绝**：
   - 被改写的引用会被某个内层的同名新绑定捕获；
   - 新名字与目标作用域中已有的其他声明冲突；
   - 作用域内现有的其他引用（含全局引用）会被改名后的绑定捕获。
5. 拒绝时返回 `{ ok: false, reason }`，不返回任何编辑（原子性）。

## API

```ts
import { planRename, applyEdits } from "./src/index.js";

interface Edit { start: number; end: number; newText: string } // UTF-8 字节偏移

const result = planRename(source, byteOffset, "newName");
if (result.ok) {
  const rewritten = applyEdits(source, result.edits); // edits 按 start 升序、不重叠
} else {
  console.error(result.reason);
}
```

## 语言子集与限制

支持的语法：`let`/`const`、函数声明/函数表达式、箭头函数、块、`if`/`else`、
`while`、`for`/`for...of`、`return`、调用、成员访问、数组/对象字面量、
常见运算符。限制：不支持解构、`var` 的函数作用域语义、模板字符串插值、
类；模板字符串按普通字符串处理。

## 测试

```
npm test
```

即 `tsc -p tsconfig.json && node --test dist/test/*.test.js`（先类型检查并编译，
再用 Node 内置 test runner 运行编译产物；本机 Node 构建不含类型剥离支持，
因此测试跑在编译后的 JS 上）。

### 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（文件级汇总）：

```
ok 1 - dist/test/rename.test.js
# tests 1
# pass 1
# fail 0
```

直接运行测试文件可见全部 24 个用例（`node dist/test/rename.test.js`）：

```
# tests 24
# pass 24
# fail 0
```

覆盖：基本重命名、两层/三层嵌套遮蔽、先用后定义（整块可见）、从引用位置发起
重命名、两类捕获拒绝、同作用域名字冲突、拒绝的原子性、函数参数/函数声明/
for 循环/箭头函数作用域、成员属性与对象键不误伤、全局引用不受影响、非法新名、
非 ASCII 文本下的 UTF-8 字节偏移、编辑计划有序且不重叠。
