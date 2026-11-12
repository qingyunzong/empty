# 抓取文档的生成编号还原

一个无运行时依赖的 TypeScript 文本提取包。爬虫宿主把已解析树、全局唯一的节点 ID 和已经算好的计数指令传入；本包只执行显式计数作用域与内容 token，不解析 CSS、不选择元素、不做布局，也不宣称完整浏览器兼容。

## 使用

```ts
import {
  extractGeneratedText,
  type ExtractionInput,
} from "./index.js";

const input: ExtractionInput = {
  roots: [
    {
      id: "chapter:1",
      instructions: {
        reset: ["chapter"],
        increment: [{ name: "chapter", value: 1 }],
      },
      before: [
        { kind: "literal", value: "Chapter " },
        { kind: "counter", name: "chapter", style: "decimal" },
      ],
      children: [
        {
          id: "section:1.1",
          instructions: {
            reset: ["section"],
            increment: [{ name: "section", value: 1 }],
          },
          before: [
            { kind: "literal", value: " / " },
            { kind: "counters", name: "section", separator: ".", style: "decimal" },
          ],
        },
      ],
    },
  ],
  initialCounters: {
    chapter: 0n,
    section: 0n,
  },
  outputByteBudget: 4096,
};

const result = extractGeneratedText(input);
console.log(result.text); // "Chapter 1 / 0.1"
```

`examples/embedded-capture.ts` 提供了一个可直接复用的采集宿主嵌入示例。

## 输入

`ExtractionInput` 的字段：

- `roots`：根节点数组。它们被当作同一个兄弟层处理；根实例预先存在。
- `initialCounters`：已声明计数名称到初始有符号整数值的映射。值可为 `bigint`、安全整数 `number`，或十进制整数字符串。每个名称都有一个创建来源为 `$initial` 的根实例。
- `outputByteBudget`：可选的非负 UTF-8 字节预算；省略时不限制。只要输出累计超过预算，整次提取失败。

节点字段：

- `id`：非空且全局唯一的字符串 ID。保留值 `$initial` 不能作为节点 ID。
- `instructions.reset`：有序的名称列表。每个条目也可写成 `{ name, value? }`，缺省重置值为 `0`。
- `instructions.set`、`instructions.increment`：有序的 `{ name, value }` 列表。
- `before`、`after`：有序内容 token 列表。
- `children`：子节点数组；每个节点的孩子构成一个新的兄弟层。
- `skipSubtree`：为真时，该节点的指令、内容和整个子树都不执行。
- `suppressText`：为真时，仍执行该节点指令并遍历孩子，但不产出该节点自身的 `before`/`after`。

内容 token：

```ts
type ContentToken =
  | { kind: "literal"; value: string }
  | { kind: "counter"; name: string; style: "decimal" | "lower-alpha" }
  | { kind: "counters"; name: string; separator: string; style: "decimal" | "lower-alpha" };
```

`counter` 读取最内层实例。`counters` 从外到内读取完整实例栈，依次格式化并用 `separator` 连接；栈中包含 `$initial` 根实例。

## 作用域语义

每次进入一组兄弟节点前都会建立空的局部实例表。节点指令按 `reset`、`set`、`increment` 的顺序执行，然后产出 `before`，再递归孩子，最后产出 `after`。

- `reset` 首次在本层创建某名称时向实例栈压入新实例；本层再次重置同名计数时，替换本层先前的实例。新实例作用于当前节点、后续兄弟及其后代。
- `set` 与 `increment` 只修改最内层实例。没有局部 `reset` 时会修改继承实例，修改在离开孩子层后仍保留。
- 退出一组兄弟时只弹出本层创建的实例，不对父层实例做数值快照或恢复。
- 同类指令列表内同名重复会失败；`reset`、`set`、`increment` 之间允许同名。
- 所有指令和 token 中的名称必须已声明，未知名称会失败。

`decimal` 使用带负号的任意精度十进制。`lower-alpha` 对正数使用 1=`a`、26=`z`、27=`aa` 的无零双射 26 进制；零和负数回退到十进制。

## 输出

`ExtractionResult.text` 是全部生成文本按执行顺序的拼接。`ExtractionResult.segments` 为每个 token 生成的一段记录：

```ts
interface ExtractionSegment {
  nodeId: string;
  position: "before" | "after";
  tokenIndex: number;
  kind: "literal" | "counter" | "counters";
  text: string;
  reads: Array<{
    name: string;
    createdBy: string; // "$initial" 或创建该实例的节点 ID
    value: string;     // 读取时的精确十进制值
  }>;
}
```

字面量段同样保留节点、阶段和 token 序号，`reads` 为空。`counter` 记录一个读实例，`counters` 按外到内记录整个被读取的实例栈。值的快照发生在取内容时，之后计数变化不会改动已有段。

## 失败条件

所有输入先在执行前完整校验，`skipSubtree` 下的结构、指令和 token 也不例外。以下任一情况都会让整次调用抛出 `ExtractionError`，不会返回部分结果：

- 树有环、节点有多个父节点、节点 ID 重复；
- 指令或 token 结构错误、样式非法、同类同名重复；
- 计数名未声明；
- 整数格式非法或输出超出字节预算。

`ExtractionError.code` 为文档化的错误类别，`path` 指向出错位置。

## 测试

```bash
npm test
```

测试构建后运行。`tests/reference-model.ts` 是一个不导入生产解释器或格式化实现的独立实例对象模型，用来对照验证兄弟层 `reset` 替换、孩子增量影响后续兄弟、嵌套同名栈、隐藏文本仍计数、巨大负数、alpha 进位及来源记录。
