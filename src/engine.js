'use strict';

const WINDOW_MS = 10 * 60 * 1000;
const TOP_N = 3;

class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.extra = extra;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function windowStartOf(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function computeBoard(liveEvents) {
  const eventIds = [...liveEvents.keys()].sort(compareStrings);
  const totals = new Map();
  for (const id of eventIds) {
    const { channel, charge } = liveEvents.get(id);
    totals.set(channel, (totals.get(channel) ?? 0) + charge);
  }
  const certificateTotals = {};
  for (const channel of [...totals.keys()].sort(compareStrings)) {
    certificateTotals[channel] = totals.get(channel);
  }
  const top = [...totals.entries()]
    .sort((a, b) => (b[1] - a[1]) || compareStrings(a[0], b[0]))
    .slice(0, TOP_N)
    .map(([channel, total]) => ({ channel, total }));
  return { top, certificate: { eventIds, totals: certificateTotals } };
}

function boardsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

class LeaderboardEngine {
  constructor() {
    this.watermark = null;
    this.versions = new Map();
    this.windows = new Map();
    this.finalBoards = new Map();
  }

  apply(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new EngineError('INVALID_EVENT', 'event must be a JSON object');
    }
    if (event.type === 'TRIGGER') return this.applyTrigger(event);
    if (event.type === 'WATERMARK') return this.applyWatermark(event);
    throw new EngineError('INVALID_EVENT', `unknown event type: ${String(event.type)}`);
  }

  isClosed(windowStart) {
    return this.watermark !== null && windowStart + WINDOW_MS <= this.watermark;
  }

  getWindow(windowStart) {
    let win = this.windows.get(windowStart);
    if (!win) {
      win = { live: new Map(), published: null, closed: false };
      this.windows.set(windowStart, win);
    }
    return win;
  }

  republish(windowStart, win) {
    if (win.closed) return [];
    const board = computeBoard(win.live);
    const prev = win.published;
    if (prev && boardsEqual(prev, board)) return [];
    const window = { start: windowStart, end: windowStart + WINDOW_MS };
    const actions = [];
    if (prev && prev.top.length > 0) {
      actions.push({ type: 'WITHDRAW', window, top: prev.top, certificate: prev.certificate });
    }
    if (board.top.length > 0) {
      actions.push({ type: 'ADD', window, top: board.top, certificate: board.certificate });
    }
    win.published = board;
    return actions;
  }

  applyTrigger(event) {
    const { eventId, version, op } = event;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new EngineError('INVALID_EVENT', 'TRIGGER requires a non-empty string eventId');
    }
    if (!isFiniteNumber(version)) {
      throw new EngineError('INVALID_EVENT', 'TRIGGER requires a finite numeric version', { eventId });
    }
    if (op !== 'UPSERT' && op !== 'RETRACT') {
      throw new EngineError('INVALID_EVENT', `unknown trigger op: ${String(op)}`, { eventId });
    }

    const existing = this.versions.get(eventId);
    if (existing && version <= existing.version) {
      throw new EngineError(
        'STALE_VERSION',
        `event ${eventId} version ${version} is not newer than ${existing.version}`,
        { eventId },
      );
    }

    if (op === 'RETRACT') {
      if (!existing) {
        throw new EngineError('UNKNOWN_RETRACT', `cannot retract unknown event ${eventId}`, { eventId });
      }
      if (existing.op === 'UPSERT' && this.isClosed(existing.windowStart)) {
        throw new EngineError('LATE', `event ${eventId} belongs to a closed window`, { eventId });
      }
      const actions = [];
      if (existing.op === 'UPSERT') {
        const win = this.windows.get(existing.windowStart);
        win.live.delete(eventId);
        actions.push(...this.republish(existing.windowStart, win));
      }
      this.versions.set(eventId, { version, op: 'RETRACT', windowStart: null });
      return actions;
    }

    const { channel, ts, charge } = event;
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new EngineError('INVALID_EVENT', 'UPSERT requires a non-empty string channel', { eventId });
    }
    if (!isFiniteNumber(ts) || ts < 0) {
      throw new EngineError('INVALID_EVENT', 'UPSERT requires a finite non-negative ts', { eventId });
    }
    if (!isFiniteNumber(charge) || charge < 0) {
      throw new EngineError('INVALID_CHARGE', 'charge must be a finite non-negative number', { eventId });
    }

    const windowStart = windowStartOf(ts);
    if (this.isClosed(windowStart)) {
      throw new EngineError('LATE', `event ${eventId} arrived after its window closed`, { eventId });
    }
    if (existing && existing.op === 'UPSERT' && this.isClosed(existing.windowStart)) {
      throw new EngineError('LATE', `event ${eventId} has state sealed in a closed window`, { eventId });
    }

    const actions = [];
    if (existing && existing.op === 'UPSERT' && existing.windowStart !== windowStart) {
      const oldWin = this.windows.get(existing.windowStart);
      oldWin.live.delete(eventId);
      actions.push(...this.republish(existing.windowStart, oldWin));
    }
    const win = this.getWindow(windowStart);
    win.live.set(eventId, { channel, charge });
    this.versions.set(eventId, { version, op: 'UPSERT', windowStart });
    actions.push(...this.republish(windowStart, win));
    return actions;
  }

  applyWatermark(event) {
    const { ts } = event;
    if (!isFiniteNumber(ts) || ts < 0) {
      throw new EngineError('INVALID_EVENT', 'WATERMARK requires a finite non-negative ts');
    }
    if (this.watermark !== null && ts <= this.watermark) return [];
    this.watermark = ts;
    for (const [windowStart, win] of this.windows) {
      if (!win.closed && windowStart + WINDOW_MS <= ts) {
        win.closed = true;
        if (win.published && win.published.top.length > 0) {
          this.finalBoards.set(windowStart, win.published);
        }
      }
    }
    return [];
  }
}

module.exports = { LeaderboardEngine, EngineError, WINDOW_MS, TOP_N };
