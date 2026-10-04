/**
 * Minimal visible-text model. Text (echo and output alike) is written at a
 * cursor; known control effects move the cursor or erase regions. The model
 * is deterministic per byte, which is what makes the parser invariant under
 * arbitrary chunking of the input stream.
 */
export class Screen {
  private lines: string[][] = [[]];
  private row = 0;
  private col = 0;

  private ensureRow(row: number): void {
    while (this.lines.length <= row) this.lines.push([]);
  }

  writeChar(ch: string): void {
    this.ensureRow(this.row);
    const line = this.lines[this.row]!;
    while (line.length < this.col) line.push(" ");
    if (this.col < line.length) line[this.col] = ch;
    else line.push(ch);
    this.col += 1;
  }

  backspace(): void {
    this.col = Math.max(0, this.col - 1);
  }

  carriageReturn(): void {
    this.col = 0;
  }

  lineFeed(): void {
    this.row += 1;
    this.ensureRow(this.row);
  }

  moveCursor(deltaRow: number, deltaCol: number): void {
    this.row = Math.max(0, this.row + deltaRow);
    this.col = Math.max(0, this.col + deltaCol);
    this.ensureRow(this.row);
  }

  /** 1-based, as in CSI_CURSOR_POSITION. */
  setCursor(col1: number, row1: number): void {
    this.row = Math.max(0, row1 - 1);
    this.col = Math.max(0, col1 - 1);
    this.ensureRow(this.row);
  }

  eraseInLine(mode: number): void {
    this.ensureRow(this.row);
    const line = this.lines[this.row]!;
    if (mode === 1) {
      for (let i = 0; i <= this.col && i < line.length; i += 1) line[i] = " ";
    } else if (mode === 2) {
      line.length = 0;
    } else {
      line.length = Math.min(line.length, this.col);
    }
  }

  eraseInDisplay(mode: number): void {
    if (mode === 1) {
      for (let r = 0; r < this.row; r += 1) this.lines[r] = [];
      this.eraseInLine(1);
    } else if (mode >= 2) {
      this.lines = [[]];
      this.row = 0;
      this.col = 0;
    } else {
      this.eraseInLine(0);
      this.lines.length = this.row + 1;
    }
  }

  /** Visible text: lines joined by "\n", trailing blanks trimmed. */
  text(): string {
    const rendered = this.lines.map((line) => line.join("").replace(/\s+$/u, ""));
    while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();
    return rendered.join("\n");
  }
}
