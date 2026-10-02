'use strict';
// 注塑机 MES 离线缓存事件包核心库(仅标准库)。
//
// 事件模型:{ lot, mold, station, seq, ts, kind, qty, hash }
// - 到达可重复、乱序、迟到;按 (lot,mold,station,seq) 去重。
// - 同 key 不同 hash 视为迟到更正:仅当被替换事件 future=false(ts <= now)时生效。
// - 虚拟时钟 now:缺失 seq 的参考时间 ref(后继事件最小 ts,无后继取前驱最大 ts),
//   now - ref >= deadline 时标记 gap(边界含等号),否则进入 NAK 重传请求表。
// - gap 不阻塞:canonical 链按有效 seq 拓扑排序(seq, station, hash)跳过缺口。
// - 守恒:每条 (lot,mold) 链上 produce/merge 为正、consume/split 为负,
//   任一前缀余额为负即守恒破坏(CLI exit 4)。
// - 证书:lot 内所有链均含 seal 且无未过期缺失时导出;内容变化只追加 revoke 与新版本,
//   已导出证书不可变。
const crypto = require('node:crypto');

const KINDS = new Set(['produce', 'consume', 'split', 'merge', 'seal']);
const DELTAS = { produce: 1, merge: 1, consume: -1, split: -1, seal: 0 };
const FIELDS = ['lot', 'mold', 'station', 'seq', 'ts', 'kind', 'qty', 'hash'];
const DEFAULT_DEADLINE = 1000;
const SEP = '\x1f';

class ValidationError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'ValidationError';
    this.line = line;
  }
}

class ConservationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ConservationError';
    this.detail = detail;
  }
}

function validateEvent(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ValidationError('event must be a JSON object');
  }
  for (const key of Object.keys(obj)) {
    if (!FIELDS.includes(key)) throw new ValidationError(`unknown field: ${key}`);
  }
  for (const field of FIELDS) {
    if (!(field in obj)) throw new ValidationError(`missing field: ${field}`);
  }
  const { lot, mold, station, seq, ts, kind, qty, hash } = obj;
  for (const [name, value] of [['lot', lot], ['mold', mold], ['station', station], ['hash', hash]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError(`${name} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(seq) || seq < 1) throw new ValidationError('seq must be an integer >= 1');
  if (!Number.isInteger(ts) || ts < 0) throw new ValidationError('ts must be an integer >= 0');
  if (!KINDS.has(kind)) throw new ValidationError(`kind must be one of: ${[...KINDS].join(', ')}`);
  if (!Number.isInteger(qty) || qty < 0) throw new ValidationError('qty must be an integer >= 0');
  if (kind !== 'seal' && qty === 0) throw new ValidationError(`qty must be > 0 for kind ${kind}`);
  return { lot, mold, station, seq, ts, kind, qty, hash };
}

function parseJsonl(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new ValidationError(`invalid JSON: ${err.message}`, i + 1);
    }
    let event;
    try {
      event = validateEvent(obj);
    } catch (err) {
      if (err instanceof ValidationError && err.line === undefined) err.line = i + 1;
      throw err;
    }
    events.push(event);
  }
  return events;
}

function keyOf(event) {
  return [event.lot, event.mold, event.station, event.seq].join(SEP);
}

function chainKeyOf(event) {
  return [event.lot, event.mold].join(SEP);
}

function streamKeyOf(event) {
  return [event.lot, event.mold, event.station].join(SEP);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortCanonical(events) {
  return [...events].sort((a, b) =>
    a.seq - b.seq || compareStrings(a.station, b.station) || compareStrings(a.hash, b.hash));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 计算一个流(同 lot/mold/station)内缺失 seq 的过期状态。
function missingInStream(events, now, deadline) {
  const present = new Set(events.map((e) => e.seq));
  let maxSeq = 0;
  for (const e of events) if (e.seq > maxSeq) maxSeq = e.seq;
  const missing = [];
  for (let s = 1; s <= maxSeq; s++) {
    if (present.has(s)) continue;
    let ref;
    let succMin = Infinity;
    let predMax = -Infinity;
    for (const e of events) {
      if (e.seq > s && e.ts < succMin) succMin = e.ts;
      if (e.seq < s && e.ts > predMax) predMax = e.ts;
    }
    if (succMin !== Infinity) ref = succMin;
    else if (predMax !== -Infinity) ref = predMax;
    else continue;
    const age = now - ref;
    missing.push({ seq: s, refTs: ref, age, expired: age >= deadline });
  }
  return missing;
}

class Store {
  constructor({ now = 0, deadline = DEFAULT_DEADLINE } = {}) {
    if (!Number.isInteger(now) || now < 0) throw new ValidationError('now must be an integer >= 0');
    if (!Number.isInteger(deadline) || deadline < 1) throw new ValidationError('deadline must be an integer >= 1');
    this.now = now;
    this.deadline = deadline;
    this.events = new Map(); // key -> event
    this.received = 0;
    this.duplicates = 0;
    this.corrections = 0;
    this.rejected = 0;
    this.certLog = [];       // 追加式证书日志,条目导出后不可变
    this.revocations = [];   // 追加式吊销记录
    this.activeCerts = new Map(); // lot -> 当前有效证书
    this.versionCounters = new Map(); // lot -> 已导出版本数
    this.sealCounts = new Map(); // lot -> seal 事件数(无 seal 则跳过证书检查)
  }

  #bumpSeal(lot, delta) {
    const next = (this.sealCounts.get(lot) || 0) + delta;
    if (next <= 0) this.sealCounts.delete(lot);
    else this.sealCounts.set(lot, next);
  }

  ingest(raw) {
    const event = validateEvent(raw);
    this.received++;
    const key = keyOf(event);
    const existing = this.events.get(key);
    if (existing) {
      if (existing.hash === event.hash) {
        this.duplicates++;
        return { applied: false, reason: 'duplicate' };
      }
      if (existing.ts > this.now) {
        // future=true 事件不可被更正
        this.rejected++;
        return { applied: false, reason: 'future-event-immutable' };
      }
      this.events.set(key, event);
      this.corrections++;
      if (existing.kind === 'seal') this.#bumpSeal(event.lot, -1);
      if (event.kind === 'seal') this.#bumpSeal(event.lot, 1);
      this.#maybeCertify(event.lot);
      return { applied: true, correction: true };
    }
    this.events.set(key, event);
    if (event.kind === 'seal') this.#bumpSeal(event.lot, 1);
    this.#maybeCertify(event.lot);
    return { applied: true };
  }

  #streams() {
    const streams = new Map();
    for (const event of this.events.values()) {
      const key = streamKeyOf(event);
      if (!streams.has(key)) streams.set(key, { lot: event.lot, mold: event.mold, station: event.station, events: [] });
      streams.get(key).events.push(event);
    }
    return streams;
  }

  #chains() {
    const chains = new Map();
    for (const event of this.events.values()) {
      const key = chainKeyOf(event);
      if (!chains.has(key)) chains.set(key, { lot: event.lot, mold: event.mold, events: [] });
      chains.get(key).events.push(event);
    }
    return chains;
  }

  // lot 的证书内容:各 mold 链 canonical 排序后的事件与已确认 gap。
  #certContent(lot) {
    const chains = [];
    for (const chain of this.#chains().values()) {
      if (chain.lot !== lot) continue;
      const gaps = [];
      let pending = 0;
      let sealed = false;
      for (const stream of this.#streams().values()) {
        if (stream.lot !== lot || stream.mold !== chain.mold) continue;
        for (const m of missingInStream(stream.events, this.now, this.deadline)) {
          if (m.expired) gaps.push(m.seq);
          else pending++;
        }
      }
      const events = sortCanonical(chain.events);
      if (events.some((e) => e.kind === 'seal')) sealed = true;
      chains.push({ mold: chain.mold, events, gaps: gaps.sort((a, b) => a - b), pending, sealed });
    }
    chains.sort((a, b) => compareStrings(a.mold, b.mold));
    return chains;
  }

  #maybeCertify(lot) {
    if (!this.sealCounts.has(lot)) return;
    const chains = this.#certContent(lot);
    if (chains.length === 0) return;
    for (const chain of chains) {
      if (!chain.sealed || chain.pending > 0) return; // gap 不阻塞,仅未过期缺失阻塞
    }
    const content = {
      lot,
      chains: chains.map((c) => ({ mold: c.mold, events: c.events, gaps: c.gaps })),
    };
    const digest = sha256hex(stableStringify(content));
    const active = this.activeCerts.get(lot);
    if (active && active.digest === digest) return;
    if (active) {
      this.revocations.push({
        lot,
        version: active.version,
        digest: active.digest,
        reason: 'superseded-by-correction',
        at: this.now,
      });
    }
    const version = (this.versionCounters.get(lot) || 0) + 1;
    this.versionCounters.set(lot, version);
    const cert = { lot, version, digest, at: this.now };
    this.certLog.push(cert);
    this.activeCerts.set(lot, cert);
  }

  finalize() {
    const chains = [];
    for (const chain of this.#chains().values()) {
      let balance = 0;
      const events = sortCanonical(chain.events).map((event) => {
        balance += DELTAS[event.kind] * event.qty;
        if (balance < 0) {
          throw new ConservationError(
            `negative balance on ${chain.lot}/${chain.mold} at seq ${event.seq} (${event.kind} qty ${event.qty} -> balance ${balance})`,
            { lot: chain.lot, mold: chain.mold, seq: event.seq, balance },
          );
        }
        return { ...event, balance };
      });
      chains.push({ lot: chain.lot, mold: chain.mold, events, finalBalance: balance });
    }
    chains.sort((a, b) => compareStrings(a.lot, b.lot) || compareStrings(a.mold, b.mold));

    const gaps = [];
    const naks = [];
    for (const stream of this.#streams().values()) {
      for (const m of missingInStream(stream.events, this.now, this.deadline)) {
        const entry = {
          lot: stream.lot, mold: stream.mold, station: stream.station,
          seq: m.seq, refTs: m.refTs, age: m.age, deadline: this.deadline,
        };
        (m.expired ? gaps : naks).push(entry);
      }
    }
    const byKey = (a, b) =>
      compareStrings(a.lot, b.lot) || compareStrings(a.mold, b.mold) ||
      compareStrings(a.station, b.station) || a.seq - b.seq;
    gaps.sort(byKey);
    naks.sort(byKey);

    return {
      now: this.now,
      deadline: this.deadline,
      chains,
      gaps,
      naks,
      certificates: this.certLog,
      revocations: this.revocations,
      stats: {
        received: this.received,
        stored: this.events.size,
        duplicates: this.duplicates,
        corrections: this.corrections,
        rejected: this.rejected,
        gaps: gaps.length,
        naks: naks.length,
        certificates: this.certLog.length,
        revocations: this.revocations.length,
      },
    };
  }
}

module.exports = {
  Store,
  validateEvent,
  parseJsonl,
  sortCanonical,
  stableStringify,
  sha256hex,
  missingInStream,
  ValidationError,
  ConservationError,
  KINDS,
  DEFAULT_DEADLINE,
};
