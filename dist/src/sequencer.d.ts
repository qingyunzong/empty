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
export declare class Sequencer<T = unknown> {
    readonly tempoMap: TempoMap;
    private evts;
    constructor(initialUsPerTick: Rational);
    addEvent(tick: number, data: T): SeqEvent<T>;
    get events(): readonly SeqEvent<T>[];
    eventTimeUs(event: SeqEvent<T>): bigint;
}
