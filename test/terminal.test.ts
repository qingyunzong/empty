import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TerminalBuffer } from "../src/index.js";
import type { Cell } from "../src/index.js";

const ACUTE = "́"; // 组合标记：acute accent
const DIAERESIS = "̈"; // 组合标记：分音符

function cell(term: TerminalBuffer, x: number, y: number): Cell {
  return term.getCell(x, y);
}

/** 全屏不应存在孤儿半格（宽字符必须成对）。 */
function assertNoOrphanHalves(term: TerminalBuffer): void {
  for (let y = 0; y < term.rows; y++) {
    for (let x = 0; x < term.cols; x++) {
      const c = cell(term, x, y);
      if (c.width === 2) {
        const right = cell(term, x + 1, y);
        assert.ok(right.cont, `宽字符 (${x},${y}) 缺右半格`);
      }
      if (c.cont) {
        const left = cell(term, x - 1, y);
        assert.equal(left.width, 2, `续格 (${x},${y}) 缺左半格`);
      }
    }
  }
}

describe("文本与回车", () => {
  test("写入文本并逐格存放", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("hello");
    assert.equal(t.lines()[0], "hello");
    assert.deepEqual(t.cursor, { x: 5, y: 0 });
  });

  test("回车回到行首并覆盖旧字符", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("hello");
    t.write("\rXY");
    assert.equal(t.lines()[0], "XYllo");
  });

  test("光标移动后写入", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("abc");
    t.setCursor(1, 0);
    t.write("Z");
    assert.equal(t.lines()[0], "aZc");
    t.cursorRight(2);
    t.write("!");
    assert.equal(t.lines()[0], "aZc !");
    t.cursorLeft(4);
    t.cursorDown(1);
    t.write("q");
    assert.equal(t.lines()[1], " q");
    t.cursorUp(1);
    assert.deepEqual(t.cursor, { x: 2, y: 0 });
  });
});

describe("宽字符", () => {
  test("宽字符占两格", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("你a");
    assert.deepEqual(cell(t, 0, 0), { text: "你", width: 2, cont: false });
    assert.deepEqual(cell(t, 1, 0), { text: "", width: 0, cont: true });
    assert.deepEqual(cell(t, 2, 0), { text: "a", width: 1, cont: false });
    assert.deepEqual(t.cursor, { x: 3, y: 0 });
  });

  test("覆盖左半格须清除整个旧字符", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("你好");
    t.setCursor(0, 0);
    t.write("a");
    assert.deepEqual(cell(t, 0, 0), { text: "a", width: 1, cont: false });
    assert.deepEqual(cell(t, 1, 0), { text: "", width: 1, cont: false }); // 右半已清
    assert.deepEqual(cell(t, 2, 0), { text: "好", width: 2, cont: false }); // 好 不动
    assertNoOrphanHalves(t);
  });

  test("覆盖右半格须清除整个旧字符", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("你好");
    t.setCursor(1, 0); // 落在 你 的右半格
    t.write("b");
    assert.deepEqual(cell(t, 0, 0), { text: "", width: 1, cont: false }); // 左半已清
    assert.deepEqual(cell(t, 1, 0), { text: "b", width: 1, cont: false });
    assert.deepEqual(cell(t, 2, 0), { text: "好", width: 2, cont: false });
    assertNoOrphanHalves(t);
  });

  test("宽字符在最后一列放不下时整字移到下一行", () => {
    const t = new TerminalBuffer(4, 3);
    t.write("abc你"); // 你 需要两格，第 4 列放不下
    assert.equal(t.lines()[0], "abc");
    assert.deepEqual(cell(t, 0, 1), { text: "你", width: 2, cont: false });
    assert.deepEqual(cell(t, 1, 1), { text: "", width: 0, cont: true });
    assertNoOrphanHalves(t);
  });
});

describe("组合标记", () => {
  test("附加到前一基字符", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("e" + ACUTE);
    assert.equal(cell(t, 0, 0).text, "e" + ACUTE);
    assert.deepEqual(t.cursor, { x: 1, y: 0 }); // 零宽不推进光标
    t.write("x");
    assert.equal(t.lines()[0], "éx");
  });

  test("附加到宽字符基字符", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("你" + ACUTE);
    assert.equal(cell(t, 0, 0).text, "你" + ACUTE);
    assert.deepEqual(cell(t, 1, 0), { text: "", width: 0, cont: true });
    assert.deepEqual(t.cursor, { x: 2, y: 0 });
  });

  test("行首组合标记独立零宽存储", () => {
    const t = new TerminalBuffer(10, 3);
    t.write(ACUTE);
    assert.deepEqual(cell(t, 0, 0), { text: ACUTE, width: 0, cont: false });
    assert.deepEqual(t.cursor, { x: 1, y: 0 });
    t.write(DIAERESIS); // 继续叠加到该独立零宽字符
    assert.equal(cell(t, 0, 0).text, ACUTE + DIAERESIS);
    t.write("a"); // 后续字符从第 2 格开始
    assert.deepEqual(cell(t, 1, 0), { text: "a", width: 1, cont: false });
  });

  test("行末写满后组合标记仍附在刚写的字符上", () => {
    const t = new TerminalBuffer(3, 2);
    t.write("abc" + ACUTE);
    assert.equal(cell(t, 2, 0).text, "c" + ACUTE);
    assert.equal(t.lines()[0], "abć");
  });
});

describe("换行覆盖", () => {
  test("换行后写入覆盖下一行旧内容", () => {
    const t = new TerminalBuffer(10, 3);
    t.write("AAAA\r\nBBBB");
    t.setCursor(0, 0);
    t.write("xy\r\nz");
    assert.equal(t.lines()[0], "xyAA");
    assert.equal(t.lines()[1], "zBBB");
  });

  test("行满自动回绕并覆盖下一行", () => {
    const t = new TerminalBuffer(4, 3);
    t.write("1234wxyz");
    assert.equal(t.lines()[0], "1234");
    assert.equal(t.lines()[1], "wxyz");
    t.setCursor(0, 0);
    t.write("ABCDEFGH"); // 回绕覆盖两行旧内容
    assert.equal(t.lines()[0], "ABCD");
    assert.equal(t.lines()[1], "EFGH");
  });

  test("末行换行触发滚动", () => {
    const t = new TerminalBuffer(6, 2);
    t.write("one\r\ntwo\r\nthree");
    assert.equal(t.lines()[0], "two");
    assert.equal(t.lines()[1], "three");
  });
});

describe("插入与删除字符", () => {
  test("插入字符右移，溢出丢弃", () => {
    const t = new TerminalBuffer(8, 2);
    t.write("abcdef");
    t.setCursor(2, 0);
    t.insertChars(2);
    assert.equal(t.lines()[0], "ab  cdef");
  });

  test("删除字符左移，末尾补空", () => {
    const t = new TerminalBuffer(8, 2);
    t.write("abcdef");
    t.setCursor(1, 0);
    t.deleteChars(2);
    assert.equal(t.lines()[0], "adef");
  });

  test("插入劈开宽字符时整字清除", () => {
    const t = new TerminalBuffer(8, 2);
    t.write("ab你cd"); // 你 占第 3、4 格
    t.setCursor(3, 0); // 在 你 的两半之间插入
    t.insertChars(1);
    assert.deepEqual(cell(t, 2, 0), { text: "", width: 1, cont: false });
    assert.deepEqual(cell(t, 3, 0), { text: "", width: 1, cont: false });
    assert.deepEqual(cell(t, 4, 0), { text: "", width: 1, cont: false });
    assert.deepEqual(cell(t, 5, 0), { text: "c", width: 1, cont: false });
    assertNoOrphanHalves(t);
  });

  test("删除劈开宽字符时整字清除", () => {
    const t = new TerminalBuffer(8, 2);
    t.write("ab你cd");
    t.setCursor(2, 0); // 删掉的只是 你 的左半
    t.deleteChars(1);
    assert.deepEqual(cell(t, 2, 0), { text: "", width: 1, cont: false }); // 右半一并清除
    assert.deepEqual(cell(t, 3, 0), { text: "c", width: 1, cont: false });
    assertNoOrphanHalves(t);
  });
});

describe("滚动与滚动区域", () => {
  function fill(t: TerminalBuffer, labels: string[]): void {
    labels.forEach((s, y) => {
      t.setCursor(0, y);
      t.write(s);
    });
  }

  test("整屏向上滚动", () => {
    const t = new TerminalBuffer(6, 3);
    fill(t, ["r0", "r1", "r2"]);
    t.scrollUp(1);
    assert.deepEqual(t.lines(), ["r1", "r2", ""]);
  });

  test("整屏向下滚动", () => {
    const t = new TerminalBuffer(6, 3);
    fill(t, ["r0", "r1", "r2"]);
    t.scrollDown(1);
    assert.deepEqual(t.lines(), ["", "r0", "r1"]);
  });

  test("局部滚动区域：区域外内容不动", () => {
    const t = new TerminalBuffer(6, 5);
    fill(t, ["r0", "r1", "r2", "r3", "r4"]);
    t.setScrollRegion(1, 3);
    t.scrollUp(1);
    assert.deepEqual(t.lines(), ["r0", "r2", "r3", "", "r4"]);
    t.scrollDown(2);
    assert.deepEqual(t.lines(), ["r0", "", "", "r2", "r4"]);
  });

  test("光标在滚动区域底换行时仅滚动区域", () => {
    const t = new TerminalBuffer(6, 4);
    fill(t, ["top", "a", "b", "bot"]);
    t.setScrollRegion(1, 2);
    t.setCursor(0, 2);
    t.write("\r\nc");
    assert.deepEqual(t.lines(), ["top", "b", "c", "bot"]);
  });

  test("宽字符跨滚动边界整字清除，不留半格", () => {
    const t = new TerminalBuffer(6, 4);
    t.setCursor(0, 0);
    t.write("你"); // 区域顶行放宽字符
    t.setCursor(0, 1);
    t.write("好");
    t.setCursor(0, 3);
    t.write("们"); // 区域外行
    t.setScrollRegion(0, 2);
    t.scrollUp(1); // 你 整字随顶行移出
    assert.deepEqual(cell(t, 0, 0), { text: "好", width: 2, cont: false });
    assert.deepEqual(cell(t, 0, 2), { text: "", width: 1, cont: false });
    assert.deepEqual(cell(t, 0, 3), { text: "们", width: 2, cont: false }); // 区域外不动
    assertNoOrphanHalves(t);
    t.scrollDown(1); // 空行进入区域顶，们 仍不动
    assert.deepEqual(cell(t, 0, 3), { text: "们", width: 2, cont: false });
    assertNoOrphanHalves(t);
  });
});

describe("保存与恢复屏幕", () => {
  test("保存后恢复屏幕与光标", () => {
    const t = new TerminalBuffer(8, 3);
    t.write("main");
    t.saveScreen();
    t.setCursor(0, 1);
    t.write("alt");
    t.restoreScreen();
    assert.equal(t.lines()[0], "main");
    assert.equal(t.lines()[1], "");
    assert.deepEqual(t.cursor, { x: 4, y: 0 });
  });

  test("旧屏幕快照不被后续组合标记修改", () => {
    const t = new TerminalBuffer(8, 3);
    t.write("e");
    t.saveScreen();
    t.write(ACUTE); // 附加到 e 上
    assert.equal(cell(t, 0, 0).text, "e" + ACUTE);
    t.restoreScreen();
    assert.equal(cell(t, 0, 0).text, "e"); // 快照仍是裸 e
    // 快照可重复恢复，且依旧不被污染
    t.write(ACUTE);
    t.write("X");
    t.restoreScreen();
    assert.equal(cell(t, 0, 0).text, "e");
    assert.equal(t.lines()[0], "e");
  });

  test("保存恢复包含滚动区域设置", () => {
    const t = new TerminalBuffer(8, 4);
    t.setScrollRegion(1, 2);
    t.saveScreen();
    t.setScrollRegion(0, 3);
    t.restoreScreen();
    assert.deepEqual(t.scrollRegion, { top: 1, bottom: 2 });
  });
});

describe("逐操作输出格状态", () => {
  test("每个操作后都能取得格状态", () => {
    const ops: string[] = [];
    const states: string[][] = [];
    const t = new TerminalBuffer(4, 2, (op, term) => {
      ops.push(op);
      states.push(term.lines());
    });
    t.write("你");
    t.write(ACUTE);
    t.write("\r\n");
    t.write("a");
    t.scrollUp(1);
    assert.deepEqual(ops, ["write", "write", "write", "write", "scrollUp"]);
    assert.deepEqual(states[0], ["你", ""]);
    assert.deepEqual(states[1], ["你́", ""]);
    assert.deepEqual(states[4], ["a", ""]);
    // 操作后格状态可逐格查询
    assert.deepEqual(t.getCell(0, 0), { text: "a", width: 1, cont: false });
  });
});
