import { Rational } from "./rational";
import { TempoMap } from "./tempo-map";
import { MusicEvent, compareEvents } from "./event";

export interface TimelineEntry {
  readonly event: MusicEvent;
  readonly beat: Rational;
  readonly ms: Rational;
}

/** A score: events pinned to rational beats plus an undoable tempo map. */
export class Score {
  readonly tempoMap: TempoMap;
  private events: MusicEvent[] = [];

  constructor(tempoMap: TempoMap = new TempoMap()) {
    this.tempoMap = tempoMap;
  }

  addEvent(event: MusicEvent): void {
    if (event.beat.isNegative()) throw new RangeError("addEvent: beat must be >= 0");
    this.events.push(event);
  }

  getEvents(): readonly MusicEvent[] {
    return this.events;
  }

  /** Tempo change: beats of all events are untouched, only derived ms move. */
  setTempo(startBeat: Rational, msPerBeat: Rational): void {
    this.tempoMap.setTempo(startBeat, msPerBeat);
  }

  /** Undo the last tempo change, restoring the previous tempo exactly. */
  undoTempo(): boolean {
    return this.tempoMap.undo();
  }

  /** Events in performance order (beat, track, id) with exact millisecond times. */
  timeline(): TimelineEntry[] {
    return [...this.events].sort(compareEvents).map((event) => ({
      event,
      beat: event.beat,
      ms: this.tempoMap.beatToMs(event.beat),
    }));
  }
}
