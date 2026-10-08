# stable-id-text

基于稳定字符 ID 的文本编辑核心库（RGA 风格），TypeScript 实现，零运行时依赖。

## 核心语义

- **稳定字符 ID**：每个字符由创建它的插入操作命名，ID 为 Lamport 时钟 + 站点 ID（`counter@site`），全局唯一且不可变。
- **选区即 ID 锚点**：选区保存为字符 ID（或文末哨兵），而非数字偏移；编辑后通过解析得到当前偏移。
- **删除锚点右移**：锚点字符被删除时，锚点沿原始字符顺序向右寻找最近的存活字符；右侧无存活字符时落到文末。
- **同位置插入按操作 ID 排序**：同一父字符下的并发插入按操作 ID 升序排列，所有副本解析结果一致。
- **分页不改 ID**：分页只是可见字符序列的分块视图；跨页移动、重排（reflow）不改变字符 ID 与全局偏移。
- **可重放合并**：各分支操作日志经 `mergeOps` 去重并按操作 ID 排序（Lamport 序即因果序）后可从头重放，结果与增量应用一致。

## API 概览

- `Document`：`insert` / `delete` / `apply` / `text` / `entries` / `Document.replay`
- `mergeOps(...logs)`：合并多支操作日志
- `caretAnchor` / `rangeSelection` / `resolveAnchor` / `resolveSelection` / `selectedText`
- `PagedDocument`：`reflow` / `moveAcrossPageBoundary` / `pages` / `locate` / `resolveSelection`

## 测试

需要环境中有 TypeScript 编译器（`tsc`，≥5.x）。无需 `npm install`：

```sh
npm test
```

等价于 `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`。
