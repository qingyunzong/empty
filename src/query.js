import { decodePostings, ActiveIndex } from './index.js';
import { normalizeTokens } from './util.js';

// Shared result shaping so the query engine and the test oracle agree.
export function shapeHit(type, device, start, end, events) {
  const spanned = events.filter((e) => !e.tombstoned && e.end >= start && e.start <= end);
  return {
    type,
    device,
    start,
    end,
    startTs: spanned.length ? spanned[0].ts : null,
    events: spanned.map((e) => e.id),
  };
}

export function compareHits(a, b) {
  if (a.startTs !== b.startTs) return a.startTs - b.startTs;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  const n = Math.min(a.events.length, b.events.length);
  for (let i = 0; i < n; i++) {
    if (a.events[i] !== b.events[i]) return a.events[i] < b.events[i] ? -1 : 1;
  }
  if (a.events.length !== b.events.length) return a.events.length - b.events.length;
  if (a.start !== b.start) return a.start - b.start;
  return a.end - b.end;
}

// Builds the unified per-device token stream across the segment chain
// (frozen segments in manifest order, then the active segment).
export function buildStreams(archive) {
  const cutoff = archive.tombstoneCutoff();
  const devices = new Map(); // device -> { events: [], postings: Map(token -> number[]) }
  const ensure = (dev) => {
    let d = devices.get(dev);
    if (!d) {
      d = { events: [], postings: new Map(), base: 0 };
      devices.set(dev, d);
    }
    return d;
  };
  const addPosting = (dev, token, pos, tombstoned) => {
    if (tombstoned) return;
    const d = ensure(dev);
    let list = d.postings.get(token);
    if (!list) { list = []; d.postings.set(token, list); }
    list.push(pos);
  };

  // Frozen layer: decode block-compressed postings via the skip list.
  for (const segId of archive.manifest.frozen) {
    const seg = archive.loadSegment(segId);
    const byDevice = new Map();
    for (const e of seg.events) {
      if (!byDevice.has(e.device)) byDevice.set(e.device, []);
      byDevice.get(e.device).push(e);
    }
    for (const [dev, events] of byDevice) {
      events.sort((a, b) => a.start - b.start);
      const d = ensure(dev);
      const base = d.base;
      for (const e of events) {
        const tombstoned = e.ts < cutoff;
        d.events.push({ id: e.id, ts: e.ts, start: base + e.start, end: base + e.start + e.tokens.length - 1, tombstoned });
      }
      for (const [token, enc] of Object.entries(seg.index.tokens)) {
        const perDev = enc.devices[dev];
        if (!perDev) continue;
        for (const pos of decodePostings(perDev)) {
          const global = base + pos;
          const owner = events.find((e) => e.start <= pos && pos < e.start + e.tokens.length);
          addPosting(dev, token, global, owner ? owner.ts < cutoff : true);
        }
      }
      d.base += seg.meta.devices[dev] || 0;
    }
  }

  // Active layer: exact small index built from the writable segment.
  const activeIdx = new ActiveIndex();
  const activeByDevice = new Map();
  const sortedActive = [...archive.activeEvents].sort((a, b) => a.ts - b.ts || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.seq - b.seq);
  for (const e of sortedActive) {
    if (!activeByDevice.has(e.device)) activeByDevice.set(e.device, []);
    activeByDevice.get(e.device).push(e);
  }
  for (const [dev, events] of activeByDevice) {
    const d = ensure(dev);
    const base = d.base;
    let cursor = 0;
    const starts = [];
    for (const e of events) {
      const tombstoned = e.ts < cutoff;
      starts.push(base + cursor);
      d.events.push({ id: e.id, ts: e.ts, start: base + cursor, end: base + cursor + e.tokens.length - 1, tombstoned });
      e.tokens.forEach((tok, i) => activeIdx.add(tok, dev, base + cursor + i));
      cursor += e.tokens.length;
    }
    for (const [token, perDevice] of activeIdx.byToken) {
      const list = perDevice.get(dev);
      if (!list) continue;
      for (const pos of list) {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        const owner = events[lo];
        addPosting(dev, token, pos, owner ? owner.ts < cutoff : true);
      }
    }
    d.base += cursor;
  }
  return devices;
}

export class Querier {
  constructor(archive) {
    this.devices = buildStreams(archive);
  }

  _postings(token) {
    const out = new Map();
    for (const [dev, d] of this.devices) {
      const list = d.postings.get(token);
      if (list && list.length) out.set(dev, list);
    }
    return out;
  }

  phrase(text) {
    const tokens = Array.isArray(text) ? text : normalizeTokens(text);
    if (tokens.length === 0) return [];
    const sets = tokens.map((t) => {
      const m = new Map();
      for (const [dev, list] of this._postings(t)) m.set(dev, new Set(list));
      return m;
    });
    const hits = [];
    for (const [dev, firstSet] of sets[0]) {
      const d = this.devices.get(dev);
      for (const pos of firstSet) {
        let ok = true;
        for (let i = 1; i < tokens.length && ok; i++) {
          const s = sets[i].get(dev);
          ok = s !== undefined && s.has(pos + i);
        }
        if (ok) hits.push(shapeHit('phrase', dev, pos, pos + tokens.length - 1, d.events));
      }
    }
    return hits.sort(compareHits);
  }

  near(a, b, k) {
    const [ta] = normalizeTokens(a);
    const [tb] = normalizeTokens(b);
    if (!ta || !tb || !Number.isInteger(k) || k < 0) return [];
    const pa = this._postings(ta);
    const pb = this._postings(tb);
    const hits = [];
    for (const [dev, listA] of pa) {
      const listB = pb.get(dev);
      if (!listB) continue;
      const d = this.devices.get(dev);
      for (const x of listA) {
        // binary search window [x-k, x+k] in listB
        let lo = 0;
        let hi = listB.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (listB[mid] < x - k) lo = mid + 1; else hi = mid;
        }
        for (let i = lo; i < listB.length && listB[i] <= x + k; i++) {
          const y = listB[i];
          if (ta === tb && y === x) continue;
          hits.push(shapeHit('near', dev, Math.min(x, y), Math.max(x, y), d.events));
        }
      }
    }
    return hits.sort(compareHits);
  }
}
