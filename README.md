# 网页标题提取中的文本区段映射

## 包入口

```ts
import { extractTextSegments, type ReadNode, type TextSegment } from "./index.js";

const segments: TextSegment[] = extractTextSegments(root, new Set(["p", "div"]));
```

## 输入契约

- `ReadNode` 为只读节点：文本节点 `text: true` 且 `data` 为 UTF-16 字符串；元素节点 `text: false`，带 `tag`、`hidden` 与 `children`。
- 块级元素集合由调用方显式传入 `ReadonlySet<string>`，标签匹配大小写敏感（调用方负责归一化）。
- 文本保证包含有效代理对，遍历按 Unicode 码点推进，来源区间为 UTF-16 半开区间 `[start, end)`。

## 归一化规则

- 跳过 `hidden` 子树，以及 `script`、`style` 子树。
- `br` 请求一次换行；块元素进入与退出各请求一次换行。
- 相邻换行请求（含嵌套块、空块、连续 `br`）合并为一个合成换行 `\n`。
- ASCII 空白（空格、制表、CR、LF、换页）连续出现时压成一个空格，跨节点的空白同样合并，并保留每个空白码点的来源区间。
- 换行两侧的空格删除；首尾换行删除，删除后暴露在首尾的空格级联删除。

## 输出契约

每个输出码点对应一个 `TextSegment`：

- `codepoint`：输出码点（合成换行固定为 `\n`）。
- `sources`：来源区间数组；合成换行为 `null`，压缩空格包含构成它的全部区间，其余码点为单元素数组。
- `isNewline`：是否为合成换行。

## 测试

逐字符参考测试覆盖跨节点空白、嵌套块换行合并、代理对区间、hidden/script/style 跳过与不可变输入。

```bash
npm run typecheck   # 严格类型检查（离线，无第三方依赖）
npm test            # 编译到 dist/ 后用 node:test 运行逐字符参考测试
```

当前运行环境的 Node 22 未编入 TypeScript 原生支持，因此测试先经 `tsc` 编译再执行，无需联网安装依赖。
