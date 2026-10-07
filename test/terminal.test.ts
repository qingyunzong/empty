import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Terminal } from "../src/terminal.js";
import { charWidth } from "../src/width-table.js";

const ACUTE = "́"; // combining acute accent
const WIDE = "你"; // CJK, width 2

test("width table is the only width source", () => {
  equal(charWidth("a".codePointAt(0)!), 1);
  equal(charWidth(WIDE.codePointAt(0)!), 2);
  equal(charWidth(ACUTE.codePointAt(0)!), 0);
  equal(charWidth("界".codePointAt(0)!), 2);
  equal(charWidth("Ａ".codePointAt(0)!), 2); // fullwidth A
});

test("plain text: cell state after each operation", () => {
  const t = new Terminal(10, 3);
  t.write("ab");
  equal(t.renderLine(0), "ab");
  deepEqual(t.cursor, { x: 2, y: 0 });
  t.write("c");
  equal(t.renderLine(0), "abc");
  deepEqual(t.cellAt(0, 0), { kind: "normal", char: "a", combining: [] });
  deepEqual(t.cellAt(5, 0), { kind: "blank", char: " ", combining: [] });
});

test("carriage return overwrites from column 0", () => {
  const t = new Terminal(10, 3);
  t.write("abc");
  t.carriageReturn();
  t.write("XY");
  equal(t.renderLine(0), "XYc");
});

test("cursor movement is clamped to the screen", () => {
  const t = new Terminal(5, 2);
  t.write("hello");
  t.cursorBack(2);
  t.write("X");
  equal(t.renderLine(0), "heXlo");
  t.cursorTo(99, 99);
  deepEqual(t.cursor, { x: 4, y: 1 });
  t.cursorUp(10);
  deepEqual(t.cursor, { x: 4, y: 0 });
  t.cursorTo(0, 0);
  t.cursorForward(3);
  deepEqual(t.cursor, { x: 3, y: 0 });
});

test("wide char occupies two cells", () => {
  const t = new Terminal(10, 3);
  t.write(WIDE);
  equal(t.renderLine(0), WIDE);
  deepEqual(t.cellAt(0, 0), { kind: "wide-left", char: WIDE, combining: [] });
  deepEqual(t.cellAt(1, 0), { kind: "wide-right", char: "", combining: [] });
  deepEqual(t.cursor, { x: 2, y: 0 });
});

test("overwriting the left half of a wide char clears the whole char", () => {
  const t = new Terminal(10, 3);
  t.write(WIDE + "x");
  t.cursorTo(0, 0);
  t.write("a");
  equal(t.renderLine(0), "a x"); // whole wide char cleared, "x" stays put
  deepEqual(t.cellAt(1, 0).kind, "blank");
});

test("overwriting the right half of a wide char clears the whole char", () => {
  const t = new Terminal(10, 3);
  t.write(WIDE + "x");
  t.cursorTo(1, 0);
  t.write("b");
  equal(t.renderLine(0), " bx");
  deepEqual(t.cellAt(0, 0).kind, "blank");
});

test("a wide char overwriting half of another clears the old one entirely", () => {
  const t = new Terminal(10, 3);
  t.write(WIDE);
  t.cursorTo(1, 0);
  t.write(WIDE);
  equal(t.renderLine(0), " " + WIDE);
  deepEqual(t.cellAt(0, 0).kind, "blank");
  deepEqual(t.cellAt(1, 0).kind, "wide-left");
  deepEqual(t.cellAt(2, 0).kind, "wide-right");
});

test("wide char at the last column wraps whole to the next line", () => {
  const t = new Terminal(5, 3);
  t.write("abcde");
  t.cursorTo(4, 0); // last column holds "e"
  t.write(WIDE); // does not fit: "e" is blanked, wide char wraps whole
  equal(t.renderLine(0), "abcd");
  equal(t.renderLine(1), WIDE);
  deepEqual(t.cellAt(4, 0).kind, "blank");
});

test("line wrap then overwrite: new text replaces old cells", () => {
  const t = new Terminal(3, 3);
  t.write("abcdef"); // wraps: "abc" / "def"
  equal(t.renderLine(0), "abc");
  equal(t.renderLine(1), "def");
  t.cursorTo(0, 0);
  t.write("XYZW");
  equal(t.renderLine(0), "XYZ");
  equal(t.renderLine(1), "Wef"); // only the written cell is replaced
});

test("newline overwrite: text after \\r\\n replaces the old line content", () => {
  const t = new Terminal(10, 3);
  t.write("hello\r\nworld");
  equal(t.renderLine(0), "hello");
  equal(t.renderLine(1), "world");
  t.cursorTo(0, 0);
  t.write("HI\r\nYO");
  equal(t.renderLine(0), "HIllo"); // written cells replaced, rest kept
  equal(t.renderLine(1), "YOrld");
});

test("combining mark attaches to the previous base char", () => {
  const t = new Terminal(10, 3);
  t.write("e" + ACUTE);
  equal(t.renderLine(0), "e" + ACUTE);
  deepEqual(t.cellAt(0, 0), { kind: "normal", char: "e", combining: [ACUTE] });
  deepEqual(t.cursor, { x: 1, y: 0 }); // zero width: cursor did not advance
});

test("combining mark attaches to a preceding wide char", () => {
  const t = new Terminal(10, 3);
  t.write(WIDE + ACUTE);
  equal(t.renderLine(0), WIDE + ACUTE);
  deepEqual(t.cellAt(0, 0).combining, [ACUTE]);
  deepEqual(t.cellAt(1, 0).combining, []);
});

test("combining mark at line start is stored standalone as zero-width", () => {
  const t = new Terminal(10, 3);
  t.write(ACUTE);
  deepEqual(t.cellAt(0, 0), { kind: "zero-width", char: "", combining: [ACUTE] });
  deepEqual(t.cursor, { x: 0, y: 0 });
  equal(t.renderLine(0), ACUTE);
  // a later base char absorbs the standalone marks
  t.write("a");
  deepEqual(t.cellAt(0, 0), { kind: "normal", char: "a", combining: [ACUTE] });
  equal(t.renderLine(0), "a" + ACUTE);
});

test("insertChars shifts right and clears a split wide char entirely", () => {
  const t = new Terminal(6, 2);
  t.write("abcd");
  t.cursorTo(1, 0);
  t.insertChars(2);
  equal(t.renderLine(0), "a  bcd");

  const t2 = new Terminal(4, 2);
  t2.write("a" + WIDE + "b"); // cells: a WL WR b
  t2.cursorTo(2, 0); // between the two halves
  t2.insertChars(1); // splits the wide char
  equal(t2.renderLine(0), "a"); // whole wide char cleared, no dangling half
  deepEqual(t2.cellAt(1, 0).kind, "blank");
  deepEqual(t2.cellAt(2, 0).kind, "blank");
});

test("deleteChars shifts left and clears a split wide char entirely", () => {
  const t = new Terminal(5, 2);
  t.write("a" + WIDE + "bc"); // a WL WR b c
  t.cursorTo(1, 0);
  t.deleteChars(1); // removes the left half
  equal(t.renderLine(0), "a bc"); // right half cleared too, no dangling half
  deepEqual(t.cellAt(1, 0).kind, "blank");
});

test("scroll up/down over the whole screen", () => {
  const t = new Terminal(5, 3);
  t.write("a");
  t.cursorTo(0, 1);
  t.write("b");
  t.cursorTo(0, 2);
  t.write("c");
  t.scrollUp(1);
  deepEqual([0, 1, 2].map((y) => t.renderLine(y)), ["b", "c", ""]);
  t.scrollDown(1);
  deepEqual([0, 1, 2].map((y) => t.renderLine(y)), ["", "b", "c"]);
});

test("scroll region can be set locally", () => {
  const t = new Terminal(5, 4);
  for (const [y, ch] of ["a", "b", "c", "d"].entries()) {
    t.cursorTo(0, y);
    t.write(ch!);
  }
  t.setScrollRegion(1, 2);
  deepEqual(t.scrollRegion, { top: 1, bottom: 2 });
  t.scrollUp(1);
  equal(t.render(), "a\nc\n\nd"); // lines outside the region untouched
  t.scrollDown(1);
  equal(t.render(), "a\n\nc\nd");
  throws(() => t.setScrollRegion(2, 2));
  throws(() => t.setScrollRegion(-1, 2));
});

test("line feed at the bottom of the region scrolls only the region", () => {
  const t = new Terminal(5, 3);
  t.setScrollRegion(0, 1);
  t.write("top");
  t.cursorTo(0, 1);
  t.write("mid");
  t.cursorTo(0, 2);
  t.write("bot");
  t.cursorTo(0, 1);
  t.lineFeed();
  equal(t.render(), "mid\n\nbot");
});

test("wide chars crossing a scroll boundary are cleared as a whole", () => {
  const t = new Terminal(6, 4);
  t.write(WIDE + WIDE); // line 0: two wide chars
  t.cursorTo(0, 1);
  t.write("x" + WIDE); // line 1: x + wide
  t.setScrollRegion(0, 2);
  t.scrollUp(1);
  // invariant: no dangling halves anywhere after scrolling
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 6; x++) {
      const c = t.cellAt(x, y);
      if (c.kind === "wide-left") {
        equal(t.cellAt(x + 1, y).kind, "wide-right");
      }
      if (c.kind === "wide-right") {
        equal(t.cellAt(x - 1, y).kind, "wide-left");
      }
    }
  }
  equal(t.renderLine(0), "x" + WIDE); // moved up intact
  t.scrollDown(1);
  equal(t.renderLine(1), "x" + WIDE); // moved back down intact
});

test("save/restore screen restores grid and cursor", () => {
  const t = new Terminal(10, 3);
  t.write("abc");
  t.saveScreen();
  t.write("XYZ");
  t.cursorTo(5, 2);
  t.write("q");
  t.restoreScreen();
  equal(t.renderLine(0), "abc");
  deepEqual(t.cursor, { x: 3, y: 0 });
});

test("old snapshots are not mutated by later combining marks", () => {
  const t = new Terminal(10, 3);
  t.write("a");
  t.saveScreen();
  t.write(ACUTE); // attaches to the live 'a'
  equal(t.renderLine(0), "a" + ACUTE);
  t.restoreScreen();
  equal(t.renderLine(0), "a"); // snapshot kept the pre-combining state
  deepEqual(t.cellAt(0, 0), { kind: "normal", char: "a", combining: [] });
  // restoring again still gives the pristine snapshot (no aliasing)
  t.write(ACUTE);
  t.restoreScreen();
  equal(t.renderLine(0), "a");
  deepEqual(t.cellAt(0, 0).combining, []);
});

test("line feed at the bottom of the screen scrolls up", () => {
  const t = new Terminal(5, 2);
  t.write("one\r\ntwo\r\n");
  equal(t.renderLine(0), "two");
  equal(t.renderLine(1), "");
  ok(t.cursor.y === 1);
});
