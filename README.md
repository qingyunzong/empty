# sheet-merge-copy

表格编辑库（TypeScript，零依赖）：矩形合并、拆分、跨区域复制，展开格模型验证。

## 规则

- **合并 `merge(range)`**：矩形合并；完全包含的旧合并被吸收，部分重叠即拒绝。
- **拆分 `unmerge(range)`**：移除被范围完整包含的合并；只切到合并的一部分即拒绝。
- **复制 `copy(src, dstRow, dstCol)`**：
  - 源区域截到合并格的一部分 → 拒绝；
  - 目标区域碰到旧合并必须完整覆盖，否则拒绝；完整覆盖则旧合并被替换；
  - 先取源快照再写入，源/目标重叠不会污染结果。
- **批量 `batch(ops)`**：任一操作失败则整体无修改（在副本上验证后提交）。
- 合并区只有锚点（左上角）存值，`get` 对覆盖格返回锚点值；`expand()` 给出展开格模型。

## 使用

```ts
import { Sheet, range } from "./dist/sheet.js";

const s = new Sheet();
s.set(0, 0, "标题");
s.merge(range(0, 0, 1, 3));          // 第 0 行合并 3 列
s.copy(range(0, 0, 2, 3), 5, 0);     // 复制到第 5 行
s.batch([                            // 原子批量
  { type: "set", row: 1, col: 0, value: 42 },
  { type: "unmerge", range: range(0, 0, 1, 3) },
]);
s.expand(6, 3);                      // 展开格模型（二维数组）
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行 test/*.test.js
```
