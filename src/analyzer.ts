// Incremental analyzer: append byte chunks, undo the most recent chunk,
// save/restore full state, and query the longest segment with no repeated
// code point whose boundaries are legal lexical states.
//
// Legality: a segment [i, j) is legal iff the lexer is in NORMAL state at
// both boundaries, i.e. it never crosses an unclosed quote and never starts
// or ends inside an escape sequence. Length is measured in code points;
// ties are broken by earliest start.

import { decodeCodePoints, encodeUtf8, nextState, ST, type LexState } from "./core.ts";

export interface BestSegment {
  cpStart: number; // code point index range [cpStart, cpEnd)
  cpEnd: number;
  length: number; // segment length in code points
  byteStart: number; // original byte range [byteStart, byteEnd)
  byteEnd: number;
  text: string;
}

// JSON-safe snapshot produced by save() and consumed by restore().
export interface Snapshot {
  cps: number[];
  byteOff: number[];
  stateAt: number[];
  winStartAt: number[];
  firstNormalAt: number[];
  bestAt: ([number, number] | null)[];
  lastSeen: [number, number][];
  mapJournal: { cp: number; prev: number }[]; // prev === -1 means "was absent"
  chunks: { cpCount: number; pendingBefore: number[] }[];
  pending: number[];
}

type Best = [number, number] | null; // [cpStart, cpEnd)

export class SegmentAnalyzer {
  private cps: number[] = [];
  private byteOff: number[] = [0]; // byteOff[i] = byte offset of code point i
  private stateAt: number[] = [ST.NORMAL]; // stateAt[i] = lex state before cp i
  private winStartAt: number[] = [0]; // sliding-window start after i code points
  private firstNormalAt: number[] = [0]; // first NORMAL boundary >= winStart
  private bestAt: Best[] = [null]; // best segment after i code points
  private lastSeen = new Map<number, number>();
  private mapJournal: { cp: number; prev: number }[] = []; // one entry per cp
  private chunks: { cpCount: number; pendingBefore: number[] }[] = [];
  private pending: number[] = []; // undecoded trailing bytes

  // Appends one chunk. Multi-byte sequences split across chunks are held in
  // `pending` until completed, so results do not depend on chunking.
  append(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? encodeUtf8(chunk) : chunk;
    const pendingBefore = [...this.pending];
    const data = new Uint8Array(this.pending.length + bytes.length);
    data.set(this.pending, 0);
    data.set(bytes, this.pending.length);
    const { cps: newCps, widths, consumed } = decodeCodePoints(data);
    this.pending = Array.from(data.subarray(consumed));
    for (let k = 0; k < newCps.length; k++) {
      this.pushCodePoint(newCps[k], widths[k]);
    }
    this.chunks.push({ cpCount: newCps.length, pendingBefore });
  }

  private pushCodePoint(cp: number, width: number): void {
    const i = this.cps.length;
    const j = i + 1;

    const prev = this.lastSeen.get(cp);
    this.mapJournal.push({ cp, prev: prev === undefined ? -1 : prev });
    let winStart = this.winStartAt[i];
    if (prev !== undefined && prev >= winStart) winStart = prev + 1;
    this.lastSeen.set(cp, i);

    this.cps.push(cp);
    this.byteOff[j] = this.byteOff[i] + width;
    this.stateAt[j] = nextState(this.stateAt[i] as LexState, cp);

    // Smallest NORMAL-state boundary >= winStart (may be j, meaning none yet).
    let firstNormal = Math.max(this.firstNormalAt[i], winStart);
    while (firstNormal <= i && this.stateAt[firstNormal] !== ST.NORMAL) {
      firstNormal++;
    }

    let best = this.bestAt[i];
    if (this.stateAt[j] === ST.NORMAL && firstNormal <= i) {
      const len = j - firstNormal;
      const bestLen = best === null ? 0 : best[1] - best[0];
      // Strictly greater wins, so equal-length segments keep the earlier start.
      if (len > bestLen) best = [firstNormal, j];
    }

    this.winStartAt[j] = winStart;
    this.firstNormalAt[j] = firstNormal;
    this.bestAt[j] = best;
  }

  // Removes the most recently appended chunk. Returns false when empty.
  undo(): boolean {
    const last = this.chunks.pop();
    if (last === undefined) return false;
    const n = this.cps.length - last.cpCount;
    this.cps.length = n;
    this.byteOff.length = n + 1;
    this.stateAt.length = n + 1;
    this.winStartAt.length = n + 1;
    this.firstNormalAt.length = n + 1;
    this.bestAt.length = n + 1;
    for (let k = this.mapJournal.length - 1; k >= n; k--) {
      const { cp, prev } = this.mapJournal[k];
      if (prev === -1) this.lastSeen.delete(cp);
      else this.lastSeen.set(cp, prev);
    }
    this.mapJournal.length = n;
    this.pending = last.pendingBefore;
    return true;
  }

  // Serializes the full state (including undo history) as JSON-safe data.
  save(): Snapshot {
    return {
      cps: [...this.cps],
      byteOff: [...this.byteOff],
      stateAt: [...this.stateAt],
      winStartAt: [...this.winStartAt],
      firstNormalAt: [...this.firstNormalAt],
      bestAt: this.bestAt.map((b) => (b === null ? null : [b[0], b[1]])),
      lastSeen: [...this.lastSeen.entries()],
      mapJournal: this.mapJournal.map((e) => ({ cp: e.cp, prev: e.prev })),
      chunks: this.chunks.map((c) => ({
        cpCount: c.cpCount,
        pendingBefore: [...c.pendingBefore],
      })),
      pending: [...this.pending],
    };
  }

  // Rebuilds an analyzer from a snapshot; appending and undoing can continue
  // exactly as if the original instance had been kept alive.
  static restore(snap: Snapshot): SegmentAnalyzer {
    const a = new SegmentAnalyzer();
    a.cps = [...snap.cps];
    a.byteOff = [...snap.byteOff];
    a.stateAt = [...snap.stateAt];
    a.winStartAt = [...snap.winStartAt];
    a.firstNormalAt = [...snap.firstNormalAt];
    a.bestAt = snap.bestAt.map((b) => (b === null ? null : ([b[0], b[1]] as Best)));
    a.lastSeen = new Map(snap.lastSeen);
    a.mapJournal = snap.mapJournal.map((e) => ({ cp: e.cp, prev: e.prev }));
    a.chunks = snap.chunks.map((c) => ({
      cpCount: c.cpCount,
      pendingBefore: [...c.pendingBefore],
    }));
    a.pending = [...snap.pending];
    return a;
  }

  // Longest legal segment with all-distinct code points, or null if none.
  best(): BestSegment | null {
    const b = this.bestAt[this.cps.length];
    if (b === null) return null;
    const [cpStart, cpEnd] = b;
    return {
      cpStart,
      cpEnd,
      length: cpEnd - cpStart,
      byteStart: this.byteOff[cpStart],
      byteEnd: this.byteOff[cpEnd],
      text: String.fromCodePoint(...this.cps.slice(cpStart, cpEnd)),
    };
  }

  get codePointCount(): number {
    return this.cps.length;
  }

  // Bytes fully decoded so far (excludes the incomplete trailing sequence).
  get byteLength(): number {
    return this.byteOff[this.cps.length];
  }
}
