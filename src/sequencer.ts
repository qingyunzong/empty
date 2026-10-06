import { TempoMap } from "./tempo-map.ts";

export interface SequencerEvent<T> {
  readonly tick: number;
  readonly data: T;
}

export interface TimedEvent<T> extends SequencerEvent<T> {
  readonly microseconds: number;
}

/**
 * A sequencer stores events at integer ticks. The tempo map is replaceable:
 * editing tempo segments never moves event ticks, it only changes the
 * computed playback time of each event.
 */
export class Sequencer<T = unknown> {
  private tempoMap: TempoMap;
  private readonly events: SequencerEvent<T>[] = [];

  constructor(tempoMap: TempoMap) {
    this.tempoMap = tempoMap;
  }

  getTempoMap(): TempoMap {
    return this.tempoMap;
  }

  /** Replace the tempo map. Event ticks are untouched. */
  setTempoMap(tempoMap: TempoMap): void {
    this.tempoMap = tempoMap;
  }

  addEvent(tick: number, data: T): void {
    if (!Number.isInteger(tick) || tick < 0) throw new Error(`Sequencer: invalid tick ${tick}`);
    this.events.push({ tick, data });
    this.events.sort((a, b) => a.tick - b.tick);
  }

  getEvents(): readonly SequencerEvent<T>[] {
    return this.events;
  }

  /** Events with playback times computed under the current tempo map. */
  getTimedEvents(): TimedEvent<T>[] {
    return this.events.map((e) => ({ ...e, microseconds: this.tempoMap.tickToMicroseconds(e.tick) }));
  }
}
