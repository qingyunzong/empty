'use strict';

const GAP_MS = 10 * 60 * 1000; // 10 minutes

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return NaN;
}

class SessionStore {
  constructor(gapMs = GAP_MS) {
    this.gapMs = gapMs;
    this.stations = new Map(); // station -> Map(id -> {eventTime, temp, version})
    this.index = new Map();    // id -> {station, version, eventTime, live}
    this.currentWatermark = null;     // max watermark seen (ms)
  }

  _stationMap(station) {
    let m = this.stations.get(station);
    if (!m) {
      m = new Map();
      this.stations.set(station, m);
    }
    return m;
  }

  _isLate(eventTimeMs) {
    return this.currentWatermark !== null && this.currentWatermark > eventTimeMs + this.gapMs;
  }

  upsert(rec) {
    const t = toMillis(rec.eventTime);
    if (this._isLate(t)) return { ok: false, error: 'LATE' };

    const existing = this.index.get(rec.id);
    if (existing) {
      if (rec.version < existing.version) return { ok: false, error: 'STALE_VERSION' };
      if (rec.version === existing.version) return { ok: true, changed: false };
      const oldMap = this.stations.get(existing.station);
      if (oldMap) oldMap.delete(rec.id);
    }

    this._stationMap(rec.station).set(rec.id, {
      eventTime: t,
      temp: rec.temp,
      version: rec.version,
    });
    this.index.set(rec.id, {
      station: rec.station,
      version: rec.version,
      eventTime: t,
      live: true,
    });
    return { ok: true, changed: true };
  }

  retract(rec) {
    const existing = this.index.get(rec.id);
    if (!existing) return { ok: false, error: 'UNKNOWN_RETRACT' };

    let t = existing.eventTime;
    if (t === undefined && rec.eventTime !== undefined) t = toMillis(rec.eventTime);
    if (t !== undefined && this._isLate(t)) return { ok: false, error: 'LATE' };

    if (rec.version !== undefined && rec.version < existing.version) {
      return { ok: false, error: 'STALE_VERSION' };
    }
    if (!existing.live) return { ok: true, changed: false };

    const m = this.stations.get(existing.station);
    if (m) m.delete(rec.id);
    existing.live = false;
    if (rec.version !== undefined) existing.version = rec.version;
    return { ok: true, changed: true };
  }

  watermark(ts) {
    const w = toMillis(ts);
    if (Number.isNaN(w)) return [];
    if (this.currentWatermark === null || w > this.currentWatermark) this.currentWatermark = w;

    const finalized = [];
    for (const [station, obs] of this.stations) {
      if (obs.size === 0) continue;
      const points = [...obs.entries()]
        .map(([id, o]) => ({ id, eventTime: o.eventTime, temp: o.temp, version: o.version }))
        .sort((a, b) => a.eventTime - b.eventTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const groups = [];
      let group = [points[0]];
      for (let i = 1; i < points.length; i++) {
        if (points[i].eventTime - points[i - 1].eventTime <= this.gapMs) {
          group.push(points[i]);
        } else {
          groups.push(group);
          group = [points[i]];
        }
      }
      groups.push(group);

      for (const g of groups) {
        const maxTime = g[g.length - 1].eventTime;
        if (this.currentWatermark > maxTime + this.gapMs) {
          let sum = 0;
          let version = g[0].version;
          for (const p of g) {
            sum += p.temp;
            if (p.version > version) version = p.version;
          }
          finalized.push({
            station,
            start: new Date(g[0].eventTime).toISOString(),
            end: new Date(maxTime).toISOString(),
            count: g.length,
            avgTemp: sum / g.length,
            ids: g.map((p) => p.id),
            version,
          });
          for (const p of g) {
            obs.delete(p.id);
            const idx = this.index.get(p.id);
            if (idx) idx.live = false;
          }
        }
      }
    }

    finalized.sort((a, b) =>
      a.station < b.station ? -1
        : a.station > b.station ? 1
          : a.start < b.start ? -1
            : a.start > b.start ? 1 : 0);
    return finalized;
  }
}

module.exports = { SessionStore, toMillis, GAP_MS };
