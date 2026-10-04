import { decodeOne } from "./utf8";

// Lexical model: a stream of code points is scanned by a tiny lexer whose
// state is a stack. Opening quotes (' " `) push a string frame; a matching
// quote pops it; a backslash inside a string pushes an escape frame which the
// next code point pops. A position is a *legal boundary* exactly when the
// stack is empty there — i.e. the position is not inside an unterminated
// string and not between a backslash and its escaped code point.

const QUOTE_SINGLE = 0x27; // '
const QUOTE_DOUBLE = 0x22; // "
const QUOTE_BACKTICK = 0x60; // `
const BACKSLASH = 0x5c; // \

function isQuote(cp: number): boolean {
  return cp === QUOTE_SINGLE || cp === QUOTE_DOUBLE || cp === QUOTE_BACKTICK;
}

export type LexFrame =
  | { kind: "string"; quote: number }
  | { kind: "escape" };

interface JournalEntry {
  cp: number;
  prevLastSeen: number; // previous index recorded for cp, -1 when absent
  prevLeft: number;
  prevBestStart: number;
  prevBestEnd: number;
  lexOp: "none" | "push" | "pop";
  lexFrame: LexFrame | null; // pushed frame (push) or popped frame (pop)
}

export interface Fragment {
  /** Code-point index of the first code point, inclusive. */
  startIndex: number;
  /** Code-point index of the last code point, inclusive. */
  endIndex: number;
  /** Byte offset in the logical input stream, inclusive. */
  startByte: number;
  /** Byte offset in the logical input stream, exclusive. */
  endByte: number;
  /** Length in code points. */
  length: number;
}

interface Snapshot {
  version: 1;
  pending: number[];
  cpByteStart: number[];
  cpByteEnd: number[];
  boundaryNormal: boolean[];
  lastSeen: Array<[number, number]>;
  left: number;
  bestStart: number;
  bestEnd: number;
  lexStack: LexFrame[];
  journal: JournalEntry[];
}

/**
 * Incremental analyzer over an append-only byte stream with tail undo.
 *
 * Maintains the longest fragment that
 *  - contains no repeated code point (combining marks count as their own
 *    code points, not as part of a grapheme), and
 *  - starts and ends at legal lexical boundaries (never inside an unclosed
 *    string or between a backslash and the code point it escapes).
 *
 * Ties are broken by the earliest start. All operations are O(log n) or
 * better amortized; undo replays a per-code-point journal in O(1).
 */
export class StreamAnalyzer {
  private pending: number[] = [];
  private cpByteStart: number[] = [];
  private cpByteEnd: number[] = [];
  private boundaryNormal: boolean[] = [true];
  private normalList: number[] = [0]; // sorted boundary indices that are legal
  private lastSeen = new Map<number, number>();
  private left = 0;
  private bestStart = -1;
  private bestEnd = -1;
  private lexStack: LexFrame[] = [];
  private journal: JournalEntry[] = [];

  /** Append raw bytes (or a string, encoded as UTF-8) to the stream. */
  append(chunk: Uint8Array | string): void {
    let bytes: Uint8Array =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (this.pending.length > 0) {
      const merged = new Uint8Array(this.pending.length + bytes.length);
      merged.set(this.pending, 0);
      merged.set(bytes, this.pending.length);
      bytes = merged;
      this.pending = [];
    }
    const base = this.byteLength;
    let offset = 0;
    while (offset < bytes.length) {
      const decoded = decodeOne(bytes, offset);
      if (decoded === null) {
        break;
      }
      this.processCodePoint(
        decoded.cp,
        base + offset,
        base + offset + decoded.byteLength,
      );
      offset += decoded.byteLength;
    }
    for (let k = offset; k < bytes.length; k++) {
      this.pending.push(bytes[k]);
    }
  }

  /**
   * Rewind the stream tail: discard any buffered incomplete UTF-8 bytes
   * (they are the newest part of the tail) and remove up to `count` of the
   * most recently decoded code points. Returns how many code points were
   * removed. After `undo(k)` the analyzer always holds a prefix of the
   * originally appended byte stream, so feeding can resume at
   * `byteLength + pendingByteCount`.
   */
  undo(count = 1): number {
    let undone = 0;
    if (count > 0) {
      this.pending = [];
    }
    while (undone < count && this.journal.length > 0) {
      this.undoOne();
      undone++;
    }
    return undone;
  }

  /** The current best fragment, or null when the stream is empty. */
  best(): Fragment | null {
    if (this.bestStart < 0) {
      return null;
    }
    return {
      startIndex: this.bestStart,
      endIndex: this.bestEnd,
      startByte: this.cpByteStart[this.bestStart],
      endByte: this.cpByteEnd[this.bestEnd],
      length: this.bestEnd - this.bestStart + 1,
    };
  }

  /** Number of fully decoded code points currently in the stream. */
  get codePointCount(): number {
    return this.cpByteStart.length;
  }

  /** Bytes consumed by fully decoded code points (excludes pending bytes). */
  get byteLength(): number {
    const n = this.cpByteEnd.length;
    return n === 0 ? 0 : this.cpByteEnd[n - 1];
  }

  /** Bytes buffered because they form an incomplete UTF-8 sequence. */
  get pendingByteCount(): number {
    return this.pending.length;
  }

  /** Current lexical stack depth (0 = next position is a legal boundary). */
  get lexDepth(): number {
    return this.lexStack.length;
  }

  /** Serialize the full state so analysis can be resumed later. */
  save(): string {
    const snapshot: Snapshot = {
      version: 1,
      pending: this.pending,
      cpByteStart: this.cpByteStart,
      cpByteEnd: this.cpByteEnd,
      boundaryNormal: this.boundaryNormal,
      lastSeen: Array.from(this.lastSeen.entries()),
      left: this.left,
      bestStart: this.bestStart,
      bestEnd: this.bestEnd,
      lexStack: this.lexStack,
      journal: this.journal,
    };
    return JSON.stringify(snapshot);
  }

  /** Restore an analyzer previously created with {@link save}. */
  static load(json: string): StreamAnalyzer {
    const s = JSON.parse(json) as Snapshot;
    if (s.version !== 1) {
      throw new Error(`unsupported snapshot version: ${String(s.version)}`);
    }
    const analyzer = new StreamAnalyzer();
    analyzer.pending = s.pending;
    analyzer.cpByteStart = s.cpByteStart;
    analyzer.cpByteEnd = s.cpByteEnd;
    analyzer.boundaryNormal = s.boundaryNormal;
    analyzer.normalList = [];
    for (let i = 0; i < s.boundaryNormal.length; i++) {
      if (s.boundaryNormal[i]) {
        analyzer.normalList.push(i);
      }
    }
    analyzer.lastSeen = new Map(s.lastSeen);
    analyzer.left = s.left;
    analyzer.bestStart = s.bestStart;
    analyzer.bestEnd = s.bestEnd;
    analyzer.lexStack = s.lexStack;
    analyzer.journal = s.journal;
    return analyzer;
  }

  private processCodePoint(cp: number, byteStart: number, byteEnd: number): void {
    const index = this.cpByteStart.length;
    const entry: JournalEntry = {
      cp,
      prevLastSeen: this.lastSeen.has(cp) ? (this.lastSeen.get(cp) as number) : -1,
      prevLeft: this.left,
      prevBestStart: this.bestStart,
      prevBestEnd: this.bestEnd,
      lexOp: "none",
      lexFrame: null,
    };
    this.applyLex(cp, entry);

    const normal = this.lexStack.length === 0;
    this.boundaryNormal.push(normal);
    if (normal) {
      this.normalList.push(index + 1);
    }

    if (entry.prevLastSeen >= 0 && entry.prevLastSeen + 1 > this.left) {
      this.left = entry.prevLastSeen + 1;
    }
    this.lastSeen.set(cp, index);

    if (normal) {
      const start = this.nextNormalBoundary(this.left);
      if (start >= 0 && start <= index) {
        const length = index - start + 1;
        const bestLength = this.bestStart < 0 ? 0 : this.bestEnd - this.bestStart + 1;
        if (
          length > bestLength ||
          (length === bestLength && (this.bestStart < 0 || start < this.bestStart))
        ) {
          this.bestStart = start;
          this.bestEnd = index;
        }
      }
    }

    this.cpByteStart.push(byteStart);
    this.cpByteEnd.push(byteEnd);
    this.journal.push(entry);
  }

  private applyLex(cp: number, entry: JournalEntry): void {
    const top = this.lexStack[this.lexStack.length - 1];
    if (top !== undefined && top.kind === "escape") {
      this.lexStack.pop();
      entry.lexOp = "pop";
      entry.lexFrame = top;
      return;
    }
    if (top !== undefined && top.kind === "string") {
      if (cp === BACKSLASH) {
        const frame: LexFrame = { kind: "escape" };
        this.lexStack.push(frame);
        entry.lexOp = "push";
        entry.lexFrame = frame;
      } else if (cp === top.quote) {
        this.lexStack.pop();
        entry.lexOp = "pop";
        entry.lexFrame = top;
      }
      return;
    }
    if (isQuote(cp)) {
      const frame: LexFrame = { kind: "string", quote: cp };
      this.lexStack.push(frame);
      entry.lexOp = "push";
      entry.lexFrame = frame;
    }
  }

  private undoOne(): void {
    const entry = this.journal.pop() as JournalEntry;
    if (entry.lexOp === "push") {
      this.lexStack.pop();
    } else if (entry.lexOp === "pop") {
      this.lexStack.push(entry.lexFrame as LexFrame);
    }
    const wasNormal = this.boundaryNormal.pop() as boolean;
    if (wasNormal) {
      // Boundaries are created in increasing order, so the one we just
      // removed is the tail of the sorted list.
      this.normalList.pop();
    }
    if (entry.prevLastSeen < 0) {
      this.lastSeen.delete(entry.cp);
    } else {
      this.lastSeen.set(entry.cp, entry.prevLastSeen);
    }
    this.left = entry.prevLeft;
    this.bestStart = entry.prevBestStart;
    this.bestEnd = entry.prevBestEnd;
    this.cpByteStart.pop();
    this.cpByteEnd.pop();
  }

  /** Smallest legal boundary index >= x, or -1 when none exists yet. */
  private nextNormalBoundary(x: number): number {
    let lo = 0;
    let hi = this.normalList.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.normalList[mid] < x) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo < this.normalList.length ? this.normalList[lo] : -1;
  }
}
