import { TerminalBuffer } from "../src/index.js";

// 逐操作输出格状态：每个操作后打印光标与每一行内容。
const term = new TerminalBuffer(8, 4, (op, t) => {
  const { x, y } = t.cursor;
  console.log(`\n== ${op} ==  光标 (${x},${y})`);
  t.lines().forEach((line, i) => console.log(`  ${i} |${line}|`));
});

term.write("ab你"); // 宽字符占两格
term.write("́"); // 组合标记附到 你
term.write("\rX"); // 回车覆盖
term.write("\nCD"); // 换行
term.setScrollRegion(1, 2); // 局部滚动区域
term.scrollUp(1); // 区域内上滚
term.saveScreen(); // 保存屏幕
term.write("̈"); // 快照之后的组合标记不影响旧屏幕
term.restoreScreen(); // 恢复屏幕
term.insertChars(1); // 插入字符
term.deleteChars(1); // 删除字符
