# terminal-buffer

终端屏幕缓冲库（TypeScript）：接收文本、回车与光标移动，维护逐格屏幕状态。

## 特性

- **宽度表**：字符宽度只由 `src/widths.ts` 给定表决定（0 组合标记 / 1 普通 / 2 宽字符）。
- **宽字符**：占两格（左半 + 续格）；覆盖任一半格会清除整个旧字符；行末放不下时整字移到下一行。
- **组合标记**：附加到前一基字符（含宽字符）；行首无基字符时独立零宽存储。
- **换行覆盖**：`\n` 换行、行满自动回绕，均覆盖已有内容；末行换行触发滚动。
- **插入/删除字符**：`insertChars` / `deleteChars`，劈开的宽字符整字清除。
- **滚动**：`scrollUp` / `scrollDown`，滚动区域可用 `setScrollRegion(top, bottom)` 局部设定；跨边界的宽字符整字清除，不留半格。
- **保存/恢复屏幕**：`saveScreen` / `restoreScreen`，快照深拷贝，后续组合标记不会修改旧快照。
- **逐操作状态输出**：构造函数传入 trace 回调，每个操作后回调并取得格状态（`lines()` / `getCell()` / `render()`）。

## 使用

```bash
npm test    # 编译并运行测试
npm run demo  # 逐操作打印格状态示例
```

```ts
import { TerminalBuffer } from "./src/index.js";

const term = new TerminalBuffer(80, 24, (op, t) => console.log(op, t.render()));
term.write("你好́\r\nworld");
term.setScrollRegion(2, 10);
term.scrollUp(1);
term.saveScreen();
term.restoreScreen();
```
