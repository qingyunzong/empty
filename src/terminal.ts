import { charWidth } from "./width-table.js";

export type CellKind =
  | "blank" // empty cell
  | "normal" // width-1 base character
  | "wide-left" // left half of a width-2 character
  | "wide-right" // right half (continuation) of a width-2 character
  | "zero-width"; // standalone combining mark(s) with no base char (line start)

export interface Cell {
  kind: CellKind;
  char: string; // base character (' ' for blank, '' for wide-right)
  combining: string[]; // combining marks attached to the base character
}

export interface Cursor {
  x: number;
  y: number;
}

interface ScreenSnapshot {
  grid: Cell[][];
  cursor: Cursor;
  scrollTop: number;
  scrollBottom: number;
}

function blankCell(): Cell {
  return { kind: "blank", char: " ", combining: [] };
}

function cloneCell(cell: Cell): Cell {
  // Deep copy: snapshots must never share the combining array with live cells,
  // so later combining marks cannot mutate an old saved screen.
  return { kind: cell.kind, char: cell.char, combining: [...cell.combining] };
}

function cloneGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.map(cloneCell));
}

export class Terminal {
  readonly cols: number;
  readonly rows: number;

  private grid: Cell[][];
  private cx = 0;
  private cy = 0;
  private scrollTop = 0;
  private scrollBottom: number;
  private wrapPending = false;
  private saved: ScreenSnapshot | null = null;

  constructor(cols: number, rows: number) {
    if (cols < 2 || rows < 1) throw new Error("cols must be >= 2, rows >= 1");
    this.cols = cols;
    this.rows = rows;
    this.scrollBottom = rows - 1;
    this.grid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, blankCell),
    );
  }

  get cursor(): Cursor {
    return { x: this.cx, y: this.cy };
  }

  get scrollRegion(): { top: number; bottom: number } {
    return { top: this.scrollTop, bottom: this.scrollBottom };
  }

  // ---------------------------------------------------------------- writing

  /** Feed text. '\n' = line feed, '\r' = carriage return, rest are printed. */
  write(text: string): void {
    for (const ch of text) {
      if (ch === "\n") {
        this.lineFeed();
        continue;
      }
      if (ch === "\r") {
        this.carriageReturn();
        continue;
      }
      const cp = ch.codePointAt(0)!;
      const w = charWidth(cp);
      if (w === 0) {
        this.putCombining(ch);
      } else if (w === 2) {
        this.putWide(ch);
      } else {
        this.putNormal(ch);
      }
    }
  }

  private putNormal(ch: string): void {
    this.commitWrap();
    this.clearWideAt(this.cx, this.cy);
    const cell = this.cell(this.cx, this.cy);
    if (cell.kind === "zero-width") {
      // A base char lands where standalone combining marks were stored:
      // the marks attach to the new base char.
      this.grid[this.cy]![this.cx] = {
        kind: "normal",
        char: ch,
        combining: cell.combining,
      };
    } else {
      this.grid[this.cy]![this.cx] = { kind: "normal", char: ch, combining: [] };
    }
    this.advance(1);
  }

  private putWide(ch: string): void {
    this.commitWrap();
    if (this.cx === this.cols - 1) {
      // No room for both halves: blank the last cell and wrap first.
      this.setCell(this.cx, this.cy, blankCell());
      this.doWrap();
    }
    // Overwriting either half of an old wide char clears the whole old char.
    this.clearWideAt(this.cx, this.cy);
    this.clearWideAt(this.cx + 1, this.cy);
    this.setCell(this.cx, this.cy, { kind: "wide-left", char: ch, combining: [] });
    this.setCell(this.cx + 1, this.cy, {
      kind: "wide-right",
      char: "",
      combining: [],
    });
    this.advance(2);
  }

  private putCombining(mark: string): void {
    if (this.wrapPending) {
      // Cursor logically sits just past the last cell: attach to that cell.
      let bx = this.cols - 1;
      if (this.cell(bx, this.cy).kind === "wide-right") bx -= 1;
      this.attachCombining(bx, this.cy, mark);
      return;
    }
    if (this.cx === 0) {
      // Line start, no preceding base char: store independently as zero-width.
      const cell = this.cell(0, this.cy);
      if (cell.kind === "zero-width") {
        cell.combining.push(mark);
      } else {
        this.clearWideAt(0, this.cy);
        this.setCell(0, this.cy, { kind: "zero-width", char: "", combining: [mark] });
      }
      return; // zero width: cursor does not move
    }
    // Attach to the previous base character. If the previous cell is the
    // right half of a wide char, the base char lives one cell further left.
    let bx = this.cx - 1;
    if (this.cell(bx, this.cy).kind === "wide-right") bx -= 1;
    this.attachCombining(bx, this.cy, mark);
  }

  private attachCombining(x: number, y: number, mark: string): void {
    const cell = this.cell(x, y);
    if (cell.kind === "blank") {
      // Attach to a blank: the blank becomes a space base char.
      cell.kind = "normal";
      cell.char = " ";
    }
    cell.combining.push(mark);
  }

  private advance(n: number): void {
    this.cx += n;
    if (this.cx >= this.cols) {
      this.cx = this.cols - 1;
      this.wrapPending = true;
    }
  }

  private commitWrap(): void {
    if (this.wrapPending) {
      this.wrapPending = false;
      this.doWrap();
    }
  }

  private doWrap(): void {
    this.cx = 0;
    this.lineFeed();
  }

  // ------------------------------------------------------------ cursor moves

  carriageReturn(): void {
    this.cx = 0;
    this.wrapPending = false;
  }

  /** Move down one line; scrolls the region up when at its bottom edge. */
  lineFeed(): void {
    this.wrapPending = false;
    if (this.cy === this.scrollBottom) {
      this.scrollUp(1);
    } else if (this.cy < this.rows - 1) {
      this.cy += 1;
    }
  }

  cursorUp(n = 1): void {
    this.wrapPending = false;
    this.cy = Math.max(0, this.cy - n);
  }

  cursorDown(n = 1): void {
    this.wrapPending = false;
    this.cy = Math.min(this.rows - 1, this.cy + n);
  }

  cursorForward(n = 1): void {
    this.wrapPending = false;
    this.cx = Math.min(this.cols - 1, this.cx + n);
  }

  cursorBack(n = 1): void {
    this.wrapPending = false;
    this.cx = Math.max(0, this.cx - n);
  }

  /** Absolute position, 0-based, clamped to the screen. */
  cursorTo(x: number, y: number): void {
    this.wrapPending = false;
    this.cx = Math.max(0, Math.min(this.cols - 1, x));
    this.cy = Math.max(0, Math.min(this.rows - 1, y));
  }

  // ------------------------------------------------------- insert / delete

  /** Insert n blank cells at the cursor; cells shift right, overflow drops. */
  insertChars(n = 1): void {
    this.wrapPending = false;
    const row = this.grid[this.cy]!;
    n = Math.min(n, this.cols - this.cx);
    for (let i = 0; i < n; i++) {
      row.splice(this.cx, 0, blankCell());
      row.length = this.cols;
    }
    this.sanitizeRow(this.cy);
  }

  /** Delete n cells at the cursor; cells shift left, blanks fill the end. */
  deleteChars(n = 1): void {
    this.wrapPending = false;
    const row = this.grid[this.cy]!;
    n = Math.min(n, this.cols - this.cx);
    for (let i = 0; i < n; i++) {
      row.splice(this.cx, 1);
      row.push(blankCell());
    }
    this.sanitizeRow(this.cy);
  }

  // --------------------------------------------------------------- scrolling

  /** Set the scroll region, 0-based inclusive rows. */
  setScrollRegion(top: number, bottom: number): void {
    if (top < 0 || bottom >= this.rows || top >= bottom) {
      throw new Error(`invalid scroll region [${top}, ${bottom}]`);
    }
    this.scrollTop = top;
    this.scrollBottom = bottom;
  }

  /** Scroll the region up n lines: top lines vanish, blanks enter at bottom. */
  scrollUp(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.scrollTop, 1);
      this.grid.splice(this.scrollBottom, 0, this.blankRow());
    }
    this.sanitizeAllRows();
  }

  /** Scroll the region down n lines: bottom lines vanish, blanks enter at top. */
  scrollDown(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, this.blankRow());
    }
    this.sanitizeAllRows();
  }

  // --------------------------------------------------------- save / restore

  /** Save a deep snapshot of the screen, cursor and scroll region. */
  saveScreen(): void {
    this.saved = {
      grid: cloneGrid(this.grid),
      cursor: { x: this.cx, y: this.cy },
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
    };
  }

  /** Restore the saved screen. The snapshot itself stays intact. */
  restoreScreen(): void {
    if (!this.saved) return;
    this.grid = cloneGrid(this.saved.grid);
    this.cx = this.saved.cursor.x;
    this.cy = this.saved.cursor.y;
    this.scrollTop = this.saved.scrollTop;
    this.scrollBottom = this.saved.scrollBottom;
    this.wrapPending = false;
  }

  // -------------------------------------------------------------- inspection

  /** Deep copy of the cell at (x, y). */
  cellAt(x: number, y: number): Cell {
    return cloneCell(this.cell(x, y));
  }

  /** Render one row to a string (trailing blanks trimmed). */
  renderLine(y: number): string {
    let out = "";
    for (const cell of this.grid[y]!) {
      out += cell.char + cell.combining.join("");
    }
    return out.trimEnd();
  }

  /** Render the whole screen, one line per row. */
  render(): string {
    return this.grid.map((_, y) => this.renderLine(y)).join("\n");
  }

  toString(): string {
    return this.render();
  }

  // ----------------------------------------------------------------- helpers

  private cell(x: number, y: number): Cell {
    return this.grid[y]![x]!;
  }

  private setCell(x: number, y: number, cell: Cell): void {
    this.grid[y]![x] = cell;
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, blankCell);
  }

  /** If (x, y) holds either half of a wide char, blank BOTH of its cells. */
  private clearWideAt(x: number, y: number): void {
    const cell = this.cell(x, y);
    if (cell.kind === "wide-left") {
      this.setCell(x, y, blankCell());
      if (x + 1 < this.cols) this.setCell(x + 1, y, blankCell());
    } else if (cell.kind === "wide-right") {
      this.setCell(x, y, blankCell());
      if (x - 1 >= 0) this.setCell(x - 1, y, blankCell());
    }
  }

  /**
   * Repair pass: any wide half whose partner is missing (split by insert,
   * delete or a scroll boundary) clears the ENTIRE character, never leaving
   * a dangling half behind.
   */
  private sanitizeRow(y: number): void {
    const row = this.grid[y]!;
    for (let x = 0; x < this.cols; x++) {
      const cell = row[x]!;
      if (cell.kind === "wide-left") {
        if (x + 1 >= this.cols || row[x + 1]!.kind !== "wide-right") {
          row[x] = blankCell();
        }
      } else if (cell.kind === "wide-right") {
        if (x === 0 || row[x - 1]!.kind !== "wide-left") {
          row[x] = blankCell();
        }
      }
    }
  }

  private sanitizeAllRows(): void {
    for (let y = 0; y < this.rows; y++) this.sanitizeRow(y);
  }
}
