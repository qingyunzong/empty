import { validateEvent } from './validate.js';
import { computePane } from './pane.js';

export const PANE_SIZE_MS = 15 * 60 * 1000;
export const PANE_SLIDE_MS = 5 * 60 * 1000;
export const FREEZE_GRACE_MS = 60 * 1000;

export class Engine {
  constructor(options = {}) {
    this.paneSize = options.paneSize ?? PANE_SIZE_MS;
    this.slide = options.slide ?? PANE_SLIDE_MS;
    this.grace = options.grace ?? FREEZE_GRACE_MS;
    this.samples = new Map();
    this.calibrations = new Map();
    this.panes = new Map();
    this.watermark = -Infinity;
    this.seq = 0;
  }

  paneStartsForPoint(ts) {
    const starts = [];
    const base = Math.floor(ts / this.slide) * this.slide;
    for (let start = base; start > ts - this.paneSize; start -= this.slide) {
      starts.push(start);
    }
    return starts;
  }

  paneStartsForRange(from, to) {
    const starts = [];
    const first = Math.ceil((from - this.paneSize + 1) / this.slide) * this.slide;
    for (let start = first; start < to; start += this.slide) {
      starts.push(start);
    }
    return starts;
  }

  isFrozen(start) {
    return this.watermark > start + this.paneSize + this.grace;
  }

  error(code, message, id) {
    const output = { type: 'ERROR', code, message };
    if (id !== undefined) output.id = id;
    return output;
  }

  ingest(raw) {
    const { event, error } = validateEvent(raw);
    if (error) {
      const id = raw && typeof raw === 'object' ? raw.id : undefined;
      return [this.error(error.code, error.message, id)];
    }

    let affected;
    if (event.type === 'FLUX') {
      if (event.op === 'UPSERT') {
        const prior = this.samples.get(event.id);
        affected = this.paneStartsForPoint(event.ts).map((start) => ({
          sensorId: event.sensorId,
          start,
        }));
        if (prior) {
          affected = affected.concat(
            this.paneStartsForPoint(prior.ts).map((start) => ({
              sensorId: prior.sensorId,
              start,
            })),
          );
        }
        if (this.allFrozen(affected)) {
          return [this.error('LATE', 'record targets a frozen pane', event.id)];
        }
        this.samples.set(event.id, {
          id: event.id,
          sensorId: event.sensorId,
          ts: event.ts,
          value: event.value,
        });
        if (event.ts > this.watermark) this.watermark = event.ts;
      } else {
        const prior = this.samples.get(event.id);
        if (!prior) {
          return [this.error('UNKNOWN_RETRACT', 'retract targets an unknown id', event.id)];
        }
        affected = this.paneStartsForPoint(prior.ts).map((start) => ({
          sensorId: prior.sensorId,
          start,
        }));
        if (this.allFrozen(affected)) {
          return [this.error('LATE', 'retract targets a frozen pane', event.id)];
        }
        this.samples.delete(event.id);
      }
    } else if (event.op === 'UPSERT') {
      const prior = this.calibrations.get(event.id);
      affected = this.paneStartsForRange(event.effectiveFrom, event.expireAt).map((start) => ({
        sensorId: event.sensorId,
        start,
      }));
      if (prior) {
        affected = affected.concat(
          this.paneStartsForRange(prior.effectiveFrom, prior.expireAt).map((start) => ({
            sensorId: prior.sensorId,
            start,
          })),
        );
      }
      if (this.allFrozen(affected)) {
        return [this.error('LATE', 'record targets a frozen pane', event.id)];
      }
      this.seq += 1;
      this.calibrations.set(event.id, {
        id: event.id,
        sensorId: event.sensorId,
        version: event.version,
        effectiveFrom: event.effectiveFrom,
        expireAt: event.expireAt,
        factor: event.factor,
        offset: event.offset,
        seq: this.seq,
      });
    } else {
      const prior = this.calibrations.get(event.id);
      if (!prior) {
        return [this.error('UNKNOWN_RETRACT', 'retract targets an unknown id', event.id)];
      }
      affected = this.paneStartsForRange(prior.effectiveFrom, prior.expireAt).map((start) => ({
        sensorId: prior.sensorId,
        start,
      }));
      if (this.allFrozen(affected)) {
        return [this.error('LATE', 'retract targets a frozen pane', event.id)];
      }
      this.calibrations.delete(event.id);
    }

    return this.recompute(affected);
  }

  allFrozen(affected) {
    return affected.every(({ start }) => this.isFrozen(start));
  }

  recompute(affected) {
    const outputs = [];
    const seen = new Set();
    const samples = [...this.samples.values()];
    const calibrations = [...this.calibrations.values()];
    for (const { sensorId, start } of affected) {
      const key = `${sensorId}|${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.isFrozen(start)) continue;
      const result = computePane({
        sensorId,
        start,
        end: start + this.paneSize,
        samples,
        calibrations,
      });
      const previous = this.panes.get(key)?.emitted ?? null;
      if (JSON.stringify(previous) === JSON.stringify(result)) continue;
      if (previous) outputs.push({ type: 'WITHDRAW', ...previous });
      if (result) outputs.push({ type: 'ADD', ...result });
      this.panes.set(key, { emitted: result });
    }
    return outputs;
  }
}
