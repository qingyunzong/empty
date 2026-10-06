import { Fraction } from "./fraction";

export interface TempoPoint {
  beat: Fraction;
  bpm: Fraction;
}

export interface TempoSegment {
  index: number;
  startBeat: Fraction;
  endBeat: Fraction | null; // null = extends to infinity
  bpm: Fraction;
  msPerBeat: Fraction;
  startMs: Fraction;
  endMs: Fraction | null;
}

export interface MusicEvent {
  id: string;
  track: number;
  beat: Fraction;
}

export interface ScheduledEvent extends MusicEvent {
  ms: Fraction;
}

export const MS_PER_MINUTE = 60000;

/**
 * Piecewise-constant tempo map. Beat positions are exact rationals;
 * every beat maps to an exact rational millisecond offset.
 * Tempo edits never move beats — only the ms projection changes.
 */
export class TempoMap {
  private points: TempoPoint[] = [{ beat: Fraction.ZERO, bpm: Fraction.of(120) }];
  private undoStack: TempoPoint[][] = [];
  private events: MusicEvent[] = [];

  private static clonePoints(points: TempoPoint[]): TempoPoint[] {
    return points.map((p) => ({ beat: p.beat, bpm: p.bpm }));
  }

  /** Insert or replace a tempo point. Pushes an undo entry. */
  setTempo(beatLike: Fraction | number | string, bpmLike: Fraction | number | string): void {
    const beat = Fraction.from(beatLike);
    const bpm = Fraction.from(bpmLike);
    if (beat.sign() < 0) throw new Error("TempoMap: beat must be >= 0");
    if (bpm.sign() <= 0) throw new Error("TempoMap: bpm must be > 0");
    this.undoStack.push(TempoMap.clonePoints(this.points));
    const idx = this.points.findIndex((p) => p.beat.eq(beat));
    if (idx >= 0) {
      this.points[idx] = { beat, bpm };
    } else {
      this.points.push({ beat, bpm });
      this.points.sort((a, b) => a.beat.cmp(b.beat));
    }
  }

  /** Restore the tempo state from before the most recent setTempo. */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.points = prev;
    return true;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get tempoPoints(): readonly TempoPoint[] {
    return this.points;
  }

  private msPerBeatAt(index: number): Fraction {
    return Fraction.of(MS_PER_MINUTE).div(this.points[index]!.bpm);
  }

  /** Cumulative exact ms at each tempo point. */
  private cumulativeMs(): Fraction[] {
    const cum: Fraction[] = [Fraction.ZERO];
    for (let i = 1; i < this.points.length; i++) {
      const span = this.points[i]!.beat.sub(this.points[i - 1]!.beat);
      cum.push(cum[i - 1]!.add(span.mul(this.msPerBeatAt(i - 1))));
    }
    return cum;
  }

  private segmentIndexAtBeat(beat: Fraction): number {
    let i = this.points.length - 1;
    while (i > 0 && this.points[i]!.beat.gt(beat)) i--;
    return i;
  }

  /** Exact rational ms offset for a beat position. */
  beatsToMs(beatLike: Fraction | number | string): Fraction {
    const beat = Fraction.from(beatLike);
    if (beat.sign() < 0) throw new Error("TempoMap: beat must be >= 0");
    const cum = this.cumulativeMs();
    const i = this.segmentIndexAtBeat(beat);
    return cum[i]!.add(beat.sub(this.points[i]!.beat).mul(this.msPerBeatAt(i)));
  }

  /** Exact rational beat position for a ms offset. */
  msToBeats(msLike: Fraction | number | string): Fraction {
    const ms = Fraction.from(msLike);
    if (ms.sign() < 0) throw new Error("TempoMap: ms must be >= 0");
    const cum = this.cumulativeMs();
    let i = cum.length - 1;
    while (i > 0 && cum[i]!.gt(ms)) i--;
    return this.points[i]!.beat.add(ms.sub(cum[i]!).div(this.msPerBeatAt(i)));
  }

  bpmAt(beatLike: Fraction | number | string): Fraction {
    const beat = Fraction.from(beatLike);
    return this.points[this.segmentIndexAtBeat(beat)]!.bpm;
  }

  segments(): TempoSegment[] {
    const cum = this.cumulativeMs();
    return this.points.map((p, i) => ({
      index: i,
      startBeat: p.beat,
      endBeat: i + 1 < this.points.length ? this.points[i + 1]!.beat : null,
      bpm: p.bpm,
      msPerBeat: this.msPerBeatAt(i),
      startMs: cum[i]!,
      endMs: i + 1 < this.points.length ? cum[i + 1]! : null,
    }));
  }

  addEvent(id: string, track: number, beatLike: Fraction | number | string): MusicEvent {
    const beat = Fraction.from(beatLike);
    if (beat.sign() < 0) throw new Error("TempoMap: event beat must be >= 0");
    const ev: MusicEvent = { id, track, beat };
    this.events.push(ev);
    return ev;
  }

  get eventList(): readonly MusicEvent[] {
    return this.events;
  }

  /**
   * Events projected to ms, ordered by (beat, track, id).
   * Beat order equals ms order because the map is monotonic.
   */
  timeline(): ScheduledEvent[] {
    return this.events
      .map((e) => ({ ...e, ms: this.beatsToMs(e.beat) }))
      .sort(
        (a, b) =>
          a.beat.cmp(b.beat) ||
          a.track - b.track ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }
}
