import { charWidth } from "./widths.js";

/**
 * 单元格：
 * - 普通字符：{ text, width: 1, cont: false }
 * - 宽字符左半：{ text, width: 2, cont: false }，右半为 { text: "", width: 0, cont: true }
 * - 行首独立组合标记：{ text: 标记, width: 0, cont: false }（零宽独立存储）
 * - 空白格：{ text: "", width: 1, cont: false }
 */
export interface Cell {
  text: string;
  width: 0 | 1 | 2;
  cont: boolean;
}

export type TraceFn = (op: string, term: TerminalBuffer) => void;

function blankCell(): Cell {
  return { text: "", width: 1, cont: false };
}

function blankRow(cols: number): Cell[] {
  return Array.from({ length: cols }, blankCell);
}

function cloneGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.map((c) => ({ ...c })));
}

interface Snapshot {
  grid: Cell[][];
  cx: number;
  cy: number;
  scrollTop: number;
  scrollBottom: number;
}

export class TerminalBuffer {
  readonly cols: number;
  readonly rows: number;

  private grid: Cell[][];
  private cx = 0;
  private cy = 0;
  private wrapPending = false;
  private scrollTop = 0;
  private scrollBottom: number;
  private saved: Snapshot | null = null;
  private readonly trace?: TraceFn;

  constructor(cols = 80, rows = 24, trace?: TraceFn) {
    if (cols < 2 || rows < 1) throw new Error("cols must be >= 2 and rows >= 1");
    this.cols = cols;
    this.rows = rows;
    this.scrollBottom = rows - 1;
    this.grid = Array.from({ length: rows }, () => blankRow(cols));
    this.trace = trace;
  }

  get cursor(): { x: number; y: number } {
    return { x: this.cx, y: this.cy };
  }

  get scrollRegion(): { top: number; bottom: number } {
    return { top: this.scrollTop, bottom: this.scrollBottom };
  }

  // ---------- 文本输入 ----------

  /** 接收文本：可打印字符、\r（回车）、\n（换行，必要时滚动）。 */
  write(text: string): void {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (ch === "\r") {
        this.cx = 0;
        this.wrapPending = false;
      } else if (ch === "\n") {
        this.linefeed();
      } else if (cp < 0x20 || cp === 0x7f) {
        // 忽略其他控制字符
      } else {
        this.putChar(ch, cp);
      }
    }
    this.emit("write");
  }

  private putChar(ch: string, cp: number): void {
    const w = charWidth(cp);
    if (w === 0) {
      this.putCombining(ch);
      return;
    }
    if (this.wrapPending) {
      this.cx = 0;
      this.linefeed();
      this.wrapPending = false;
    }
    // 宽字符在最后一列放不下：该列置空，整字移到下一行行首
    if (w === 2 && this.cx === this.cols - 1) {
      this.setCell(this.cx, this.cy, blankCell());
      this.cx = 0;
      this.linefeed();
    }
    // 覆盖任一半格，须清除整个旧字符
    this.clearWideAt(this.cx, this.cy);
    if (w === 2) this.clearWideAt(this.cx + 1, this.cy);
    this.setCell(this.cx, this.cy, { text: ch, width: w, cont: false });
    if (w === 2) {
      this.setCell(this.cx + 1, this.cy, { text: "", width: 0, cont: true });
    }
    this.cx += w;
    if (this.cx >= this.cols) {
      this.cx = this.cols - 1;
      this.wrapPending = true;
    }
  }

  private putCombining(mark: string): void {
    if (this.wrapPending) {
      // 附加到刚写完的字符（位于最后一列）
      this.appendMark(this.cx, this.cy, mark);
      return;
    }
    if (this.cx === 0) {
      // 行首没有基字符：组合标记独立零宽存储，占一个逻辑格位
      const first = this.grid[this.cy][0];
      if (first.width === 0 && !first.cont && first.text !== "") {
        first.text += mark; // 已有独立零宽标记，继续叠加
      } else {
        this.clearWideAt(0, this.cy);
        this.setCell(0, this.cy, { text: mark, width: 0, cont: false });
      }
      this.cx = 1;
      return;
    }
    // 附加到前一基字符
    this.appendMark(this.cx - 1, this.cy, mark);
  }

  private appendMark(x: number, y: number, mark: string): void {
    let cell = this.grid[y][x];
    if (cell.cont) {
      // 落点在宽字符右半：附到左半基字符上
      cell = this.grid[y][x - 1];
    }
    cell.text += mark;
  }

  /** 覆盖 (x,y) 时若该格是宽字符的任一半，整字清除。 */
  private clearWideAt(x: number, y: number): void {
    const cell = this.grid[y][x];
    if (cell.cont) {
      this.setCell(x - 1, y, blankCell());
      this.setCell(x, y, blankCell());
    } else if (cell.width === 2) {
      this.setCell(x, y, blankCell());
      this.setCell(x + 1, y, blankCell());
    }
  }

  // ---------- 光标移动 ----------

  cursorUp(n = 1): void {
    this.cy = Math.max(0, this.cy - n);
    this.wrapPending = false;
    this.emit("cursorUp");
  }

  cursorDown(n = 1): void {
    this.cy = Math.min(this.rows - 1, this.cy + n);
    this.wrapPending = false;
    this.emit("cursorDown");
  }

  cursorLeft(n = 1): void {
    this.cx = Math.max(0, this.cx - n);
    this.wrapPending = false;
    this.emit("cursorLeft");
  }

  cursorRight(n = 1): void {
    this.cx = Math.min(this.cols - 1, this.cx + n);
    this.wrapPending = false;
    this.emit("cursorRight");
  }

  setCursor(x: number, y: number): void {
    this.cx = Math.max(0, Math.min(this.cols - 1, x));
    this.cy = Math.max(0, Math.min(this.rows - 1, y));
    this.wrapPending = false;
    this.emit("setCursor");
  }

  // ---------- 插入 / 删除字符 ----------

  /** 在当前行光标处插入 n 个空格，右侧溢出丢弃；劈开的宽字符整字清除。 */
  insertChars(n = 1): void {
    const row = this.grid[this.cy];
    const at = Math.min(this.cx, this.cols - 1);
    row.splice(at, 0, ...Array.from({ length: n }, blankCell));
    row.length = this.cols;
    this.repairRow(this.cy);
    this.emit("insertChars");
  }

  /** 删除光标处 n 个字符，左侧补齐空格；劈开的宽字符整字清除。 */
  deleteChars(n = 1): void {
    const row = this.grid[this.cy];
    const at = Math.min(this.cx, this.cols - 1);
    row.splice(at, n);
    while (row.length < this.cols) row.push(blankCell());
    this.repairRow(this.cy);
    this.emit("deleteChars");
  }

  // ---------- 滚动 ----------

  /** 设定滚动区域（0 起，含端点），光标归位到 (0,0)。 */
  setScrollRegion(top: number, bottom: number): void {
    const t = Math.max(0, Math.min(this.rows - 1, top));
    const b = Math.max(0, Math.min(this.rows - 1, bottom));
    if (t >= b) throw new Error("scroll region requires top < bottom");
    this.scrollTop = t;
    this.scrollBottom = b;
    this.cx = 0;
    this.cy = 0;
    this.wrapPending = false;
    this.emit("setScrollRegion");
  }

  /** 区域内向上滚动 n 行：顶行移出，底部补空行。区域外不动。 */
  scrollUp(n = 1): void {
    this.doScrollUp(n);
    this.emit("scrollUp");
  }

  /** 区域内向下滚动 n 行：底行移出，顶部补空行。区域外不动。 */
  scrollDown(n = 1): void {
    this.doScrollDown(n);
    this.emit("scrollDown");
  }

  private doScrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.scrollTop, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
    }
    this.repairBoundaryRows();
  }

  private doScrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, blankRow(this.cols));
    }
    this.repairBoundaryRows();
  }

  private linefeed(): void {
    if (this.cy === this.scrollBottom) {
      this.doScrollUp(1);
    } else if (this.cy < this.rows - 1) {
      this.cy += 1;
    }
  }

  /**
   * 滚动后检查区域边界行：若有宽字符跨滚动边界被劈开
   * （只剩一半格），整字清除，不留残格。
   */
  private repairBoundaryRows(): void {
    for (let y = 0; y < this.rows; y++) this.repairRow(y);
  }

  /** 清除行内所有“孤儿半格”：无右半的宽字符头、无左半的续格。 */
  private repairRow(y: number): void {
    const row = this.grid[y];
    for (let x = 0; x < this.cols; x++) {
      const cell = row[x];
      if (cell.width === 2) {
        const next = row[x + 1];
        if (!next || !next.cont) {
          row[x] = blankCell();
        } else {
          x++; // 跳过配对的右半格
        }
      } else if (cell.cont) {
        row[x] = blankCell();
      }
    }
  }

  // ---------- 保存 / 恢复屏幕 ----------

  /** 保存屏幕快照（深拷贝）：之后的组合标记等修改不得影响快照。 */
  saveScreen(): void {
    this.saved = {
      grid: cloneGrid(this.grid),
      cx: this.cx,
      cy: this.cy,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
    };
    this.emit("saveScreen");
  }

  /** 恢复屏幕到快照状态；快照本身保持原样，可重复恢复。 */
  restoreScreen(): void {
    if (!this.saved) return;
    this.grid = cloneGrid(this.saved.grid);
    this.cx = this.saved.cx;
    this.cy = this.saved.cy;
    this.scrollTop = this.saved.scrollTop;
    this.scrollBottom = this.saved.scrollBottom;
    this.wrapPending = false;
    this.emit("restoreScreen");
  }

  // ---------- 状态输出 ----------

  /** 读取格子状态（返回副本）。 */
  getCell(x: number, y: number): Cell {
    return { ...this.grid[y][x] };
  }

  /** 逐行文本（行尾空白裁剪）。 */
  lines(): string[] {
    return this.grid.map((row) =>
      row
        .map((c) => {
          if (c.cont) return "";
          if (c.text === "") return " ";
          return c.text;
        })
        .join("")
        .trimEnd(),
    );
  }

  render(): string {
    return this.lines().join("\n");
  }

  private setCell(x: number, y: number, cell: Cell): void {
    this.grid[y][x] = cell;
  }

  private emit(op: string): void {
    this.trace?.(op, this);
  }
}
