import { Rational } from "./rational";

export interface TempoSegment {
  /** Inclusive beat at which this segment starts. */
  readonly startBeat: Rational;
  /** Milliseconds per beat inside this segment. */
  readonly msPerBeat: Rational;
  /** Exact cumulative millisecond offset at startBeat. */
  readonly startMs: Rational;
}

/**
 * Piecewise-constant tempo map. Beats are the canonical timeline; milliseconds
 * are derived. Every computation is exact rational arithmetic, so
 * msToBeat(beatToMs(b)) === b holds with no floating-point error.
 */
export class TempoMap {
  private segments: TempoSegment[] = [];
  private history: TempoSegment[][] = [];

  constructor(initialMsPerBeat: Rational = Rational.of(500)) {
    if (initialMsPerBeat.cmp(Rational.zero()) <= 0) {
      throw new RangeError("TempoMap: msPerBeat must be positive");
    }
    this.segments = [
      { startBeat: Rational.zero(), msPerBeat: initialMsPerBeat, startMs: Rational.zero() },
    ];
  }

  static fromBpm(bpm: Rational): TempoMap {
    return new TempoMap(Rational.of(60000).div(bpm));
  }

  getSegments(): readonly TempoSegment[] {
    return this.segments;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /** Set the tempo starting at startBeat; later segments keep their own tempo. Undoable. */
  setTempo(startBeat: Rational, msPerBeat: Rational): void {
    if (startBeat.isNegative()) throw new RangeError("setTempo: startBeat must be >= 0");
    if (msPerBeat.cmp(Rational.zero()) <= 0) {
      throw new RangeError("setTempo: msPerBeat must be positive");
    }
    this.history.push(this.segments.map((s) => ({ ...s })));

    const idx = this.segmentIndexForBeat(startBeat);
    const at = this.segments[idx]!;
    if (at.startBeat.equals(startBeat)) {
      this.segments[idx] = { ...at, msPerBeat };
    } else {
      this.segments.splice(idx + 1, 0, { startBeat, msPerBeat, startMs: Rational.zero() });
    }
    this.recompute();
  }

  /** Restore the tempo map to its state before the most recent setTempo. */
  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.segments = prev;
    return true;
  }

  beatToMs(beat: Rational): Rational {
    if (beat.isNegative()) throw new RangeError("beatToMs: beat must be >= 0");
    const seg = this.segments[this.segmentIndexForBeat(beat)]!;
    return seg.startMs.add(beat.sub(seg.startBeat).mul(seg.msPerBeat));
  }

  msToBeat(ms: Rational): Rational {
    if (ms.isNegative()) throw new RangeError("msToBeat: ms must be >= 0");
    let idx = 0;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i]!.startMs.cmp(ms) <= 0) idx = i;
      else break;
    }
    const seg = this.segments[idx]!;
    return seg.startBeat.add(ms.sub(seg.startMs).div(seg.msPerBeat));
  }

  msPerBeatAt(beat: Rational): Rational {
    if (beat.isNegative()) throw new RangeError("msPerBeatAt: beat must be >= 0");
    return this.segments[this.segmentIndexForBeat(beat)]!.msPerBeat;
  }

  /** Numeric lookup used only by the direct-integration reference model. */
  msPerBeatAtNumber(beat: number): number {
    if (beat < 0) throw new RangeError("msPerBeatAtNumber: beat must be >= 0");
    let idx = 0;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i]!.startBeat.toNumber() <= beat) idx = i;
      else break;
    }
    return this.segments[idx]!.msPerBeat.toNumber();
  }

  private segmentIndexForBeat(beat: Rational): number {
    let idx = 0;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i]!.startBeat.cmp(beat) <= 0) idx = i;
      else break;
    }
    return idx;
  }

  private recompute(): void {
    for (let i = 1; i < this.segments.length; i++) {
      const prev = this.segments[i - 1]!;
      const cur = this.segments[i]!;
      const startMs = prev.startMs.add(cur.startBeat.sub(prev.startBeat).mul(prev.msPerBeat));
      this.segments[i] = { ...cur, startMs };
    }
  }
}
