import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  DAY_MS,
  ValidationError,
  dayStartMs,
  dayString,
  hashCounts,
  parseTime,
  validateBatch,
} from './model.js';
import { rebuild } from './reference.js';

function checksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function compareVersions(a, b) {
  return a.tx_time_ms - b.tx_time_ms || a.seq - b.seq;
}

// Incremental bitemporal engine backed by an append-only JSONL log.
//
// Crash model: a transaction is durable once its single log line is appended.
// A crash after the append but before the in-memory apply is healed by
// replaying the log on startup; a crash before the append leaves no trace.
// A torn final line (crash mid-append) fails checksum/parse and is ignored.
export class Engine {
  constructor(logPath) {
    this.logPath = logPath;
    this.entries = [];
    this.txIndex = new Map();
    this.reverts = new Map();
    this.equip = new Map();
    this.counts = new Map();
    this.minDayMs = null;
    this.maxDayMs = null;
    this.seq = 0;
  }

  static load(logPath) {
    const engine = new Engine(logPath);
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let payload;
        try {
          const record = JSON.parse(line);
          const { checksum: sum, ...rest } = record;
          if (typeof sum !== 'string' || sum !== checksum(rest)) break;
          payload = rest;
        } catch {
          break;
        }
        engine.replay(payload);
      }
    }
    return engine;
  }

  replay(payload) {
    if (payload.type === 'commit') this.applyCommit(payload);
    else if (payload.type === 'revert') this.applyRevert(payload);
    else throw new ValidationError(`unknown log entry type: ${payload.type}`);
  }

  commit(batch) {
    const validated = validateBatch(batch);
    if (this.txIndex.has(validated.tx_id)) {
      throw new ValidationError(`duplicate tx_id: ${validated.tx_id}`);
    }
    const payload = { type: 'commit', ...validated };
    this.appendLine(payload);
    return this.applyCommit(payload);
  }

  revert(txId, txTimeIso) {
    if (!this.txIndex.has(txId)) {
      throw new ValidationError(`unknown tx_id: ${txId}`);
    }
    if (this.reverts.has(txId)) {
      throw new ValidationError(`tx_id already reverted: ${txId}`);
    }
    const txTimeMs = txTimeIso !== undefined ? parseTime(txTimeIso, 'tx_time') : Date.now();
    const payload = {
      type: 'revert',
      reverted_tx_id: txId,
      tx_time: new Date(txTimeMs).toISOString(),
    };
    this.appendLine(payload);
    return this.applyRevert(payload);
  }

  appendLine(payload) {
    const line = JSON.stringify({ ...payload, checksum: checksum(payload) }) + '\n';
    fs.appendFileSync(this.logPath, line);
  }

  applyCommit(payload) {
    const txTimeMs = parseTime(payload.tx_time, 'tx_time');
    const events = payload.events.map((event) => ({
      ...event,
      valid_ms: parseTime(event.valid_time, 'valid_time'),
    }));
    const entry = { type: 'commit', tx_id: payload.tx_id, tx_time_ms: txTimeMs, events };
    this.entries.push(entry);
    this.txIndex.set(payload.tx_id, entry);

    let minAffectedDay = Infinity;
    for (const event of events) {
      this.insertVersion(event.equipment, event.valid_ms, {
        state: event.state,
        tx_id: payload.tx_id,
        tx_time_ms: txTimeMs,
        seq: this.seq++,
      });
      const day = dayStartMs(event.valid_ms);
      if (day < minAffectedDay) minAffectedDay = day;
      if (this.minDayMs === null || day < this.minDayMs) this.minDayMs = day;
      if (this.maxDayMs === null || day > this.maxDayMs) this.maxDayMs = day;
    }
    const deltas = this.recomputeRange(minAffectedDay, this.maxDayMs);
    return { deltas, hash: this.hash() };
  }

  applyRevert(payload) {
    const txId = payload.reverted_tx_id;
    const revertTxTimeMs = parseTime(payload.tx_time, 'tx_time');
    this.reverts.set(txId, revertTxTimeMs);
    this.entries.push({ type: 'revert', reverted_tx_id: txId, tx_time_ms: revertTxTimeMs });

    const oldMin = this.minDayMs;
    const oldMax = this.maxDayMs;
    this.recomputeBounds();
    const deltas = [];
    if (oldMin !== null) {
      for (let day = oldMin; day <= oldMax; day += DAY_MS) {
        const key = dayString(day);
        const before = this.counts.get(key) ?? { up: 0, down: 0 };
        if (this.minDayMs !== null && day >= this.minDayMs && day <= this.maxDayMs) {
          const after = this.recomputeDay(day);
          this.counts.set(key, after);
          pushDelta(deltas, key, before, after);
        } else {
          this.counts.delete(key);
          pushDelta(deltas, key, before, { up: 0, down: 0 });
        }
      }
    }
    return { deltas, hash: this.hash() };
  }

  insertVersion(equipment, validMs, version) {
    let eq = this.equip.get(equipment);
    if (!eq) {
      eq = { times: [], versions: new Map() };
      this.equip.set(equipment, eq);
    }
    let list = eq.versions.get(validMs);
    if (!list) {
      eq.times.splice(lowerBound(eq.times, validMs), 0, validMs);
      list = [];
      eq.versions.set(validMs, list);
    }
    let index = list.length;
    while (index > 0 && compareVersions(list[index - 1], version) > 0) index -= 1;
    list.splice(index, 0, version);
  }

  stateAt(equipment, tMs) {
    const eq = this.equip.get(equipment);
    if (!eq) return null;
    for (let i = upperBound(eq.times, tMs) - 1; i >= 0; i -= 1) {
      const list = eq.versions.get(eq.times[i]);
      for (let j = list.length - 1; j >= 0; j -= 1) {
        if (!this.reverts.has(list[j].tx_id)) return list[j].state;
      }
    }
    return null;
  }

  recomputeDay(dayMs) {
    let up = 0;
    let down = 0;
    const endOfDay = dayMs + DAY_MS - 1;
    for (const equipment of this.equip.keys()) {
      const state = this.stateAt(equipment, endOfDay);
      if (state === 'up') up += 1;
      else if (state === 'down') down += 1;
    }
    return { up, down };
  }

  recomputeRange(fromDayMs, toDayMs) {
    const deltas = [];
    for (let day = fromDayMs; day <= toDayMs; day += DAY_MS) {
      const key = dayString(day);
      const before = this.counts.get(key) ?? { up: 0, down: 0 };
      const after = this.recomputeDay(day);
      this.counts.set(key, after);
      pushDelta(deltas, key, before, after);
    }
    return deltas;
  }

  recomputeBounds() {
    this.minDayMs = null;
    this.maxDayMs = null;
    for (const entry of this.entries) {
      if (entry.type !== 'commit' || this.reverts.has(entry.tx_id)) continue;
      for (const event of entry.events) {
        const day = dayStartMs(event.valid_ms);
        if (this.minDayMs === null || day < this.minDayMs) this.minDayMs = day;
        if (this.maxDayMs === null || day > this.maxDayMs) this.maxDayMs = day;
      }
    }
  }

  hash() {
    return hashCounts(this.counts);
  }

  asOf(txTimeMs) {
    return rebuild(this.entries, txTimeMs);
  }

  verify() {
    const reference = rebuild(this.entries);
    if (reference.counts.size !== this.counts.size) return false;
    for (const [day, value] of this.counts) {
      const other = reference.counts.get(day);
      if (!other || other.up !== value.up || other.down !== value.down) return false;
    }
    return true;
  }
}

function pushDelta(deltas, day, before, after) {
  const up = after.up - before.up;
  const down = after.down - before.down;
  if (up !== 0 || down !== 0) {
    const delta = { date: day };
    if (up !== 0) delta.up = up;
    if (down !== 0) delta.down = down;
    deltas.push(delta);
  }
}
