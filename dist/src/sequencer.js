import { TempoMap } from "./tempo-map.js";
/**
 * Minimal event list over a shared TempoMap. Events store integer ticks only;
 * microsecond positions are always derived from the map on demand, so editing
 * tempo segments re-times events without ever moving their ticks.
 */
export class Sequencer {
    tempoMap;
    evts = [];
    constructor(initialUsPerTick) {
        this.tempoMap = new TempoMap(initialUsPerTick);
    }
    addEvent(tick, data) {
        if (!Number.isSafeInteger(tick) || tick < 0) {
            throw new RangeError(`tick must be a non-negative safe integer, got ${tick}`);
        }
        const event = { tick, data };
        const idx = this.evts.findIndex((e) => e.tick > tick);
        if (idx === -1)
            this.evts.push(event);
        else
            this.evts.splice(idx, 0, event);
        return event;
    }
    get events() {
        return this.evts;
    }
    eventTimeUs(event) {
        return this.tempoMap.tickToUs(event.tick);
    }
}
