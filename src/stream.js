import { normalizeEvent } from './model.js';
import { optimize } from './scheduler.js';

export const WATERMARK_MS = 120_000;

function diffSchedules(prev, cur) {
  const a = prev && prev.schedules.length > 0 ? prev.schedules[0] : [];
  const b = cur && cur.schedules.length > 0 ? cur.schedules[0] : [];
  const before = new Map(a.map((p) => [p.job, p]));
  const changed = [];
  for (const p of b) {
    const q = before.get(p.job);
    if (!q || q.start !== p.start || q.end !== p.end) changed.push(p.job);
    before.delete(p.job);
  }
  for (const job of before.keys()) changed.push(job);
  return changed.sort();
}

export class Processor {
  constructor(opts = {}) {
    this.opts = opts;
    this.watermarkMs = opts.watermarkMs ?? WATERMARK_MS;
    this.orders = new Map();
    this.maints = new Map();
    this.maxEventTs = -Infinity;
    this.watermark = -Infinity;
    this.corrections = [];
    this.lateLog = [];
    this.current = this.recompute();
  }

  recompute() {
    const blocked = [...this.maints.values()].map((m) => [m.start, m.end]);
    const t0 = this.maxEventTs === -Infinity ? 0 : this.maxEventTs;
    return optimize(this.orders, blocked, t0, this.opts);
  }

  ingest(raw) {
    const ev = normalizeEvent(raw);
    const late = ev.eventTs < this.watermark;

    let applied = true;
    if (ev.type === 'order') {
      this.orders.set(ev.job, ev);
    } else if (ev.type === 'maint') {
      this.maints.set(ev.id, ev);
    } else {
      const map = ev.kind === 'order' ? this.orders : this.maints;
      if (map.has(ev.id)) map.delete(ev.id);
      else applied = false;
    }

    if (ev.eventTs > this.maxEventTs) {
      this.maxEventTs = ev.eventTs;
      this.watermark = this.maxEventTs - this.watermarkMs;
    }

    if (!applied) {
      if (late) {
        this.lateLog.push(
          `eventTs=${ev.eventTs} retract ${ev.kind} ${ev.id}: unknown id, beyond watermark ${this.watermark}, not retractable`,
        );
      }
      return { late, applied: false };
    }

    const prev = this.current;
    this.current = this.recompute();

    if (late) {
      this.corrections.push({
        seq: this.corrections.length + 1,
        eventTs: ev.eventTs,
        kind: ev.type === 'retract' ? `retract:${ev.kind}` : ev.type,
        id: ev.type === 'order' ? ev.job : ev.id,
        watermark: this.watermark,
        changedJobs: diffSchedules(prev, this.current),
      });
    }
    return { late, applied: true };
  }
}
