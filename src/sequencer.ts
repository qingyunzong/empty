import { Rational } from "./rational.js";
import { TempoMap } from "./tempo-map.js";

export interface SeqEvent<T> {
  readonly tick: number;
  readonly data: T;
}

/**
 * Minimal event list over a shared TempoMap. Events store integer ticks only;
 * microsecond positions are always derived from the map on demand, so editing
 * tempo segments re-times events without ever moving their ticks.
 */
export class Sequencer<T = unknown> {
  readonly tempoMap: TempoMap;
  private evts: SeqEvent<T>[] = [];

  constructor(initialUsPerTick: Rational) {
    this.tempoMap = new TempoMap(initialUsPerTick);
  }

  addEvent(tick: number, data: T): SeqEvent<T> {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new RangeError(`tick must be a non-negative safe integer, got ${tick}`);
    }
    const event: SeqEvent<T> = { tick, data };
    const idx = this.evts.findIndex((e) => e.tick > tick);
    if (idx === -1) this.evts.push(event);
    else this.evts.splice(idx, 0, event);
    return event;
  }

  get events(): readonly SeqEvent<T>[] {
    return this.evts;
  }

  eventTimeUs(event: SeqEvent<T>): bigint {
    return this.tempoMap.tickToUs(event.tick);
  }
}
