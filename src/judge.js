'use strict';

const crypto = require('node:crypto');
const { CODES, ComplianceError } = require('./errors');
const { enabledRoles } = require('./nfa');

const MAX_LOG_EVENTS = 1000;
const GENESIS_FP = 'genesis';

function eventFingerprint(ev) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([ev.id, ev.ts, ev.role]), 'utf8')
    .digest('hex');
}

// Chained fingerprint of a log prefix: fp_k = H(fp_{k-1} : H(event_k)).
// Any correction at position i invalidates every cached entry after i.
function chainFingerprint(prevFp, ev) {
  return crypto
    .createHash('sha256')
    .update(`${prevFp}:${eventFingerprint(ev)}`, 'utf8')
    .digest('hex');
}

function validateEvents(events) {
  if (!Array.isArray(events)) {
    throw new ComplianceError(CODES.INVALID_EVENT, 'log must be an array of events');
  }
  if (events.length > MAX_LOG_EVENTS) {
    throw new ComplianceError(CODES.LOG_LIMIT, `log exceeds the ${MAX_LOG_EVENTS} event limit`);
  }
  const seen = new Set();
  let prevTs = null;
  events.forEach((ev, index) => {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new ComplianceError(CODES.INVALID_EVENT, `event ${index} must be an object`);
    }
    if (typeof ev.id !== 'string' || ev.id.length === 0) {
      throw new ComplianceError(CODES.INVALID_EVENT, `event ${index} has an invalid id`);
    }
    if (seen.has(ev.id)) {
      throw new ComplianceError(CODES.ID_REUSE, `duplicate event id "${ev.id}"`);
    }
    seen.add(ev.id);
    if (typeof ev.ts !== 'number' || !Number.isFinite(ev.ts)) {
      throw new ComplianceError(CODES.INVALID_EVENT, `event "${ev.id}" has an invalid timestamp`);
    }
    if (prevTs !== null && ev.ts < prevTs) {
      throw new ComplianceError(
        CODES.TIME_REORDER,
        `event "${ev.id}" timestamp ${ev.ts} precedes previous timestamp ${prevTs}`
      );
    }
    prevTs = ev.ts;
    if (typeof ev.role !== 'string' || ev.role.length === 0) {
      throw new ComplianceError(CODES.INVALID_EVENT, `event "${ev.id}" has an invalid role`);
    }
  });
}

function replay(dfa, startState, events, fromIndex) {
  let state = startState;
  const path = [state];
  let consumed = 0;
  for (let i = fromIndex; i < events.length; i++) {
    const row = dfa.trans.get(state);
    const next = row ? row.get(events[i].role) : undefined;
    if (next === undefined) {
      return { state, path, consumed, failIndex: i };
    }
    state = next;
    path.push(state);
    consumed += 1;
  }
  return { state, path, consumed, failIndex: -1 };
}

function buildVerdict(dfa, events, replayed) {
  const { state, path, consumed, failIndex } = replayed;
  const consumedIds = events.slice(0, consumed).map((e) => e.id);
  if (failIndex === -1 && dfa.accept.has(state)) {
    // The DFA is deterministic, so the replayed trajectory is the unique
    // (and therefore shortest) compliant path for this log.
    return {
      verdict: 'accept',
      reason: null,
      path,
      consumed: consumedIds,
      prefix: events.map((e) => e.id),
      continuations: enabledRoles(dfa, state),
      finalState: state,
    };
  }
  const prefix =
    failIndex === -1
      ? events.map((e) => e.id)
      : events.slice(0, failIndex + 1).map((e) => e.id);
  return {
    verdict: 'reject',
    reason: failIndex === -1 ? 'NOT_ACCEPTING' : 'NO_TRANSITION',
    path,
    consumed: consumedIds,
    prefix,
    continuations: enabledRoles(dfa, state),
    finalState: state,
  };
}

function judgeEvents(dfa, events) {
  validateEvents(events);
  return buildVerdict(dfa, events, replay(dfa, dfa.start, events, 0));
}

// Incremental re-judging session. Supports append / retract / replace
// corrections and reuses cached prefix states guarded by chained
// fingerprints, so results always match a full replay.
class IncrementalSession {
  constructor(dfa) {
    this.dfa = dfa;
    this.events = [];
    this.cache = new Map([[0, { fp: GENESIS_FP, state: dfa.start }]]);
    this.stats = { reused: 0, computed: 0 };
  }

  append(event) {
    this.events.push(event);
    return this.judge();
  }

  retract(id) {
    const index = this.events.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new ComplianceError(CODES.INVALID_EVENT, `cannot retract unknown event id "${id}"`);
    }
    this.events.splice(index, 1);
    return this.judge();
  }

  replace(id, event) {
    const index = this.events.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new ComplianceError(CODES.INVALID_EVENT, `cannot replace unknown event id "${id}"`);
    }
    this.events[index] = event;
    return this.judge();
  }

  cacheStats() {
    const total = this.stats.reused + this.stats.computed;
    return {
      reused: this.stats.reused,
      computed: this.stats.computed,
      hitRate: total === 0 ? 0 : this.stats.reused / total,
    };
  }

  judge() {
    const events = this.events;
    validateEvents(events);
    const n = events.length;
    const fps = new Array(n + 1);
    fps[0] = GENESIS_FP;
    for (let i = 0; i < n; i++) {
      fps[i + 1] = chainFingerprint(fps[i], events[i]);
    }
    // Longest contiguous cached prefix whose chained fingerprint still matches.
    let start = 0;
    let state = this.dfa.start;
    const prefixStates = [this.dfa.start];
    for (let k = 1; k <= n; k++) {
      const entry = this.cache.get(k);
      if (!entry || entry.fp !== fps[k]) break;
      if (!this.dfa.stateSet.has(entry.state)) {
        throw new ComplianceError(
          CODES.CACHE_POISON,
          `cache entry at prefix ${k} matches the log fingerprint but holds unknown state "${entry.state}"`
        );
      }
      prefixStates.push(entry.state);
      start = k;
      state = entry.state;
    }
    this.stats.reused += start;
    this.stats.computed += n - start;
    const tail = replay(this.dfa, state, events, start);
    const path = prefixStates.concat(tail.path.slice(1));
    for (let k = start + 1; k <= n; k++) {
      const idx = k - start;
      if (idx < tail.path.length) {
        this.cache.set(k, { fp: fps[k], state: tail.path[idx] });
      } else {
        this.cache.delete(k);
      }
    }
    for (const key of [...this.cache.keys()]) {
      if (key > n) this.cache.delete(key);
    }
    const result = buildVerdict(this.dfa, events, {
      state: tail.state,
      path,
      consumed: start + tail.consumed,
      failIndex: tail.failIndex,
    });
    return { ...result, cache: this.cacheStats() };
  }
}

module.exports = {
  MAX_LOG_EVENTS,
  GENESIS_FP,
  eventFingerprint,
  chainFingerprint,
  validateEvents,
  judgeEvents,
  IncrementalSession,
};
