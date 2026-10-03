'use strict';

const WINDOW_MS = 10 * 60 * 1000; // 10-minute tumbling windows
const TOP_N = 3;
const ALLOWED_LATENESS_MS = 0;

function windowStartOf(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sortedChannelSums(sums) {
  const out = {};
  for (const ch of [...sums.keys()].sort()) out[ch] = sums.get(ch);
  return out;
}

function computeTop(sums, n) {
  return [...sums.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([channel, total]) => ({ channel, total }));
}

class Engine {
  constructor() {
    this.watermark = null; // highest watermark ts seen
    this.versions = new Map(); // eventId -> highest version seen
    this.active = new Map(); // eventId -> { version, windowStart, channel, charge }
    this.windows = new Map(); // windowStart -> { sums: Map, eventIds: Set, published: ranking|null, closed: bool }
  }

  _window(ws) {
    let w = this.windows.get(ws);
    if (!w) {
      w = { sums: new Map(), eventIds: new Set(), published: null, closed: false };
      this.windows.set(ws, w);
    }
    return w;
  }

  _isLate(ts) {
    if (this.watermark === null) return false;
    // window closes when watermark reaches its end (allowed lateness = 0)
    return windowStartOf(ts) + WINDOW_MS <= this.watermark;
  }

  _certificate(ws, w) {
    return {
      windowStart: ws,
      windowEnd: ws + WINDOW_MS,
      eventIds: [...w.eventIds].sort(),
      channels: sortedChannelSums(w.sums),
    };
  }

  _republish(ws) {
    const w = this.windows.get(ws);
    const top3 = computeTop(w.sums, TOP_N);
    const ranking = {
      windowStart: ws,
      windowEnd: ws + WINDOW_MS,
      top3,
      certificate: this._certificate(ws, w),
    };
    const prev = w.published;
    // a publication covers top3 plus the certificate (all participant ids and
    // per-channel sums), so any state change in an open window republishes
    if (prev !== null && JSON.stringify(prev) === JSON.stringify({ type: 'ADD', ...ranking })) {
      return [];
    }
    if (prev === null && top3.length === 0) return [];
    const actions = [];
    if (prev !== null) actions.push({ type: 'WITHDRAW', ...prev });
    if (top3.length > 0) {
      actions.push({ type: 'ADD', ...ranking });
      w.published = ranking;
    } else {
      w.published = null;
    }
    return actions;
  }

  _addContribution(ws, eventId, channel, charge) {
    const w = this._window(ws);
    w.sums.set(channel, (w.sums.get(channel) || 0) + charge);
    w.eventIds.add(eventId);
  }

  _removeContribution(ev) {
    const w = this.windows.get(ev.windowStart);
    if (!w) return;
    const next = (w.sums.get(ev.channel) || 0) - ev.charge;
    if (Math.abs(next) < 1e-9) w.sums.delete(ev.channel);
    else w.sums.set(ev.channel, next);
    w.eventIds.delete(ev.eventId);
  }

  apply(record) {
    const actions = [];
    const errors = [];
    const err = (code, extra) => errors.push({ error: code, ...extra });

    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      err('INVALID_EVENT', { record: record === undefined ? null : record });
      return { actions, errors };
    }

    if (record.type === 'WATERMARK') {
      if (!isFiniteNumber(record.ts)) {
        err('INVALID_WATERMARK', { record });
        return { actions, errors };
      }
      if (this.watermark === null || record.ts > this.watermark) {
        this.watermark = record.ts;
        for (const [ws, w] of this.windows) {
          if (!w.closed && ws + WINDOW_MS <= this.watermark) w.closed = true;
        }
      }
      return { actions, errors };
    }

    if (record.type !== 'TRIGGER') {
      err('INVALID_EVENT', { record });
      return { actions, errors };
    }

    const { eventId, version, op } = record;
    if (typeof eventId !== 'string' || eventId.length === 0 || !isFiniteNumber(version)) {
      err('INVALID_EVENT', { record });
      return { actions, errors };
    }

    if (op === 'UPSERT') {
      const { channel, ts, charge } = record;
      if (typeof channel !== 'string' || channel.length === 0 || !isFiniteNumber(ts)) {
        err('INVALID_EVENT', { record });
        return { actions, errors };
      }
      if (!isFiniteNumber(charge) || charge < 0) {
        err('INVALID_CHARGE', { eventId, record });
        return { actions, errors };
      }
      if (this._isLate(ts)) {
        err('LATE', { eventId, ts, watermark: this.watermark });
        return { actions, errors };
      }
      const seen = this.versions.get(eventId);
      if (seen !== undefined && version <= seen) {
        err('STALE_VERSION', { eventId, version, seenVersion: seen });
        return { actions, errors };
      }
      this.versions.set(eventId, version);
      const prev = this.active.get(eventId);
      const touched = new Set();
      if (prev) {
        this._removeContribution(prev);
        touched.add(prev.windowStart);
      }
      const ws = windowStartOf(ts);
      const entry = { eventId, version, windowStart: ws, channel, charge };
      this.active.set(eventId, entry);
      this._addContribution(ws, eventId, channel, charge);
      touched.add(ws);
      for (const t of touched) actions.push(...this._republish(t));
      return { actions, errors };
    }

    if (op === 'RETRACT') {
      const prev = this.active.get(eventId);
      if (!prev) {
        err('UNKNOWN_RETRACT', { eventId, version });
        return { actions, errors };
      }
      if (this._isLate(prev.windowStart)) {
        err('LATE', { eventId, windowStart: prev.windowStart, watermark: this.watermark });
        return { actions, errors };
      }
      if (version <= prev.version) {
        err('STALE_VERSION', { eventId, version, seenVersion: prev.version });
        return { actions, errors };
      }
      this.versions.set(eventId, version);
      this.active.delete(eventId);
      this._removeContribution(prev);
      actions.push(...this._republish(prev.windowStart));
      return { actions, errors };
    }

    err('INVALID_EVENT', { record });
    return { actions, errors };
  }
}

module.exports = { Engine, WINDOW_MS, TOP_N, ALLOWED_LATENESS_MS, windowStartOf, computeTop };
