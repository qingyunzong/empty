'use strict';

const crypto = require('node:crypto');

const ROLES = Object.freeze(['经办', '复核', '清算', '归档']);
const MAX_LOG = 1000;
const MAX_STATES = 200;

class FlowError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'FlowError';
    this.code = code;
  }
}

const EPSILON_LABELS = new Set(['', 'ε', 'eps', 'epsilon', 'EPSILON', null, undefined]);

// ---------- flow parsing ----------

function parseFlow(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new FlowError('FLOW_INVALID', 'flow must be a JSON object');
  }
  const states = json.states;
  if (!Array.isArray(states) || states.length === 0) {
    throw new FlowError('FLOW_INVALID', 'flow.states must be a non-empty array');
  }
  const stateSet = new Set(states);
  if (stateSet.size !== states.length) throw new FlowError('FLOW_INVALID', 'duplicate state names');
  if (!stateSet.has(json.start)) throw new FlowError('FLOW_INVALID', 'unknown start state');
  const accept = new Set(json.accept || []);
  for (const a of accept) {
    if (!stateSet.has(a)) throw new FlowError('FLOW_INVALID', `unknown accept state ${a}`);
  }
  const alphabet = Array.isArray(json.alphabet) && json.alphabet.length > 0
    ? [...json.alphabet]
    : [...ROLES];
  const raw = json.transitions;
  if (!Array.isArray(raw)) throw new FlowError('FLOW_INVALID', 'flow.transitions must be an array');
  const trans = new Map(); // from -> Map(role -> Set(to))
  let count = 0;
  for (const t of raw) {
    const from = Array.isArray(t) ? t[0] : t.from;
    const role = Array.isArray(t) ? t[1] : (t.role !== undefined ? t.role : t.symbol);
    const to = Array.isArray(t) ? t[2] : t.to;
    if (EPSILON_LABELS.has(role)) {
      throw new FlowError('NFA_EPSILON_ONLY', 'epsilon transitions are not supported');
    }
    count++;
    if (!stateSet.has(from) || !stateSet.has(to)) {
      throw new FlowError('FLOW_INVALID', `transition endpoint unknown: ${from} -> ${to}`);
    }
    if (!alphabet.includes(role)) alphabet.push(role);
    let m = trans.get(from);
    if (!m) { m = new Map(); trans.set(from, m); }
    let s = m.get(role);
    if (!s) { s = new Set(); m.set(role, s); }
    s.add(to);
  }
  if (count === 0) throw new FlowError('NFA_EPSILON_ONLY', 'flow has no symbol transitions');
  return { states, stateSet, start: json.start, accept, alphabet, trans };
}

// ---------- subset construction ----------

function subsetConstruction(nfa, maxStates = MAX_STATES) {
  const keyOf = (set) => [...set].sort().join('');
  const startSet = new Set([nfa.start]);
  const ids = new Map([[keyOf(startSet), 0]]);
  const sets = [startSet];
  const trans = [new Map()];
  const accept = new Set();
  for (let i = 0; i < sets.length; i++) {
    const cur = sets[i];
    for (const s of cur) {
      if (nfa.accept.has(s)) { accept.add(i); break; }
    }
    for (const role of nfa.alphabet) {
      const next = new Set();
      for (const s of cur) {
        const m = nfa.trans.get(s);
        const dst = m && m.get(role);
        if (dst) for (const d of dst) next.add(d);
      }
      if (next.size === 0) continue;
      const k = keyOf(next);
      let id = ids.get(k);
      if (id === undefined) {
        id = sets.length;
        if (id >= maxStates) {
          throw new FlowError('STATE_LIMIT', `dfa exceeds ${maxStates} states`);
        }
        ids.set(k, id);
        sets.push(next);
        trans.push(new Map());
      }
      trans[i].set(role, id);
    }
  }
  return { alphabet: [...nfa.alphabet], start: 0, accept, trans, count: sets.length };
}

// ---------- DFA minimization (partition refinement) ----------

function minimizeDFA(dfa) {
  const n = dfa.count;
  let cls = new Array(n);
  for (let s = 0; s < n; s++) cls[s] = dfa.accept.has(s) ? 1 : 0;
  for (;;) {
    const sig = new Map();
    const next = new Array(n);
    for (let s = 0; s < n; s++) {
      let key = String(cls[s]);
      for (const role of dfa.alphabet) {
        const t = dfa.trans[s].get(role);
        key += '|' + (t === undefined ? '-' : cls[t]);
      }
      let id = sig.get(key);
      if (id === undefined) { id = sig.size; sig.set(key, id); }
      next[s] = id;
    }
    if (sig.size === new Set(cls).size) { cls = next; break; }
    cls = next;
  }
  const groupOf = new Map();
  const groups = [];
  for (let s = 0; s < n; s++) {
    let g = groupOf.get(cls[s]);
    if (g === undefined) { g = groups.length; groupOf.set(cls[s], g); groups.push([]); }
    groups[g].push(s);
  }
  const trans = groups.map((members) => {
    const m = new Map();
    for (const [role, t] of dfa.trans[members[0]]) m.set(role, groupOf.get(cls[t]));
    return m;
  });
  const accept = new Set();
  for (let g = 0; g < groups.length; g++) {
    if (groups[g].some((s) => dfa.accept.has(s))) accept.add(g);
  }
  return {
    alphabet: dfa.alphabet,
    start: groupOf.get(cls[dfa.start]),
    accept,
    trans,
    count: groups.length,
  };
}

// canonical BFS renaming so equivalent DFAs hash identically
function canonicalize(dfa) {
  const rename = new Map([[dfa.start, 0]]);
  const order = [dfa.start];
  for (let qi = 0; qi < order.length; qi++) {
    const s = order[qi];
    for (const role of dfa.alphabet) {
      const t = dfa.trans[s].get(role);
      if (t !== undefined && !rename.has(t)) {
        rename.set(t, rename.size);
        order.push(t);
      }
    }
  }
  for (let s = 0; s < dfa.count; s++) {
    if (!rename.has(s)) { rename.set(s, rename.size); order.push(s); }
  }
  const trans = order.map((s) => {
    const m = new Map();
    for (const [role, t] of dfa.trans[s]) m.set(role, rename.get(t));
    return m;
  });
  const accept = new Set([...dfa.accept].map((s) => rename.get(s)));
  return { alphabet: dfa.alphabet, start: 0, accept, trans, count: order.length };
}

function dfaHash(dfa) {
  const rows = [];
  for (let s = 0; s < dfa.count; s++) {
    for (const [role, t] of [...dfa.trans[s]].sort()) rows.push([s, role, t]);
  }
  const canon = JSON.stringify({
    a: dfa.alphabet,
    s: dfa.start,
    f: [...dfa.accept].sort((x, y) => x - y),
    t: rows,
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// shortest compliant path (BFS over minimized DFA)
function shortestAcceptPath(dfa) {
  if (dfa.accept.has(dfa.start)) return { roles: [], states: [dfa.start] };
  const prev = new Map();
  const seen = new Set([dfa.start]);
  const queue = [dfa.start];
  for (let qi = 0; qi < queue.length; qi++) {
    const s = queue[qi];
    for (const role of dfa.alphabet) {
      const t = dfa.trans[s].get(role);
      if (t === undefined || seen.has(t)) continue;
      seen.add(t);
      prev.set(t, { from: s, role });
      if (dfa.accept.has(t)) {
        const roles = [];
        const states = [t];
        let cur = t;
        while (cur !== dfa.start) {
          const p = prev.get(cur);
          roles.unshift(p.role);
          states.unshift(p.from);
          cur = p.from;
        }
        return { roles, states };
      }
      queue.push(t);
    }
  }
  return null;
}

function compileFlow(flowJson) {
  const nfa = parseFlow(flowJson);
  const subset = subsetConstruction(nfa);
  const minimized = canonicalize(minimizeDFA(subset));
  return {
    nfa,
    dfa: minimized,
    hash: dfaHash(minimized),
    shortestPath: shortestAcceptPath(minimized),
    stats: { subsetStates: subset.count, minimizedStates: minimized.count },
  };
}

// ---------- log validation ----------

function validateLog(events) {
  if (!Array.isArray(events)) throw new FlowError('LOG_INVALID', 'log must be an array');
  if (events.length > MAX_LOG) {
    throw new FlowError('LOG_LIMIT', `log exceeds ${MAX_LOG} events`);
  }
  const seen = new Set();
  let prevTs = -Infinity;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || ev.id == null
        || typeof ev.ts !== 'number' || typeof ev.role !== 'string') {
      throw new FlowError('LOG_INVALID', 'each event needs {id, ts, role}');
    }
    if (seen.has(ev.id)) throw new FlowError('ID_REUSE', `duplicate event id ${ev.id}`);
    seen.add(ev.id);
    if (ev.ts < prevTs) {
      throw new FlowError('TIME_REORDER', `event ${ev.id} timestamp out of order`);
    }
    prevTs = ev.ts;
  }
}

// ---------- judging ----------

function buildResult(compiled, events, state, consumed) {
  const dfa = compiled.dfa;
  const complete = consumed === events.length;
  const accepted = complete && dfa.accept.has(state);
  const result = {
    verdict: accepted ? 'accept' : 'reject',
    consumed,
    prefix: events.slice(0, consumed),
    continuations: [...dfa.trans[state].keys()].sort(),
    finalState: state,
  };
  if (!complete) result.failingEvent = events[consumed];
  if (accepted) result.path = compiled.shortestPath;
  return result;
}

function judgeEvents(compiled, events) {
  validateLog(events);
  const dfa = compiled.dfa;
  let state = dfa.start;
  let consumed = 0;
  for (const ev of events) {
    const next = dfa.trans[state].get(ev.role);
    if (next === undefined) break;
    state = next;
    consumed++;
  }
  return buildResult(compiled, events, state, consumed);
}

// ---------- incremental session with state cache ----------

function prefixKeys(seed, events) {
  const keys = new Array(events.length);
  let h = 'dfa:' + seed;
  for (let i = 0; i < events.length; i++) {
    h = crypto.createHash('sha256')
      .update(h + '|' + String(events[i].id) + '|' + events[i].role)
      .digest('hex');
    keys[i] = h;
  }
  return keys;
}

class Session {
  constructor(flowOrCompiled, opts = {}) {
    this.compiled = flowOrCompiled && flowOrCompiled.dfa
      ? flowOrCompiled
      : compileFlow(flowOrCompiled);
    this.events = [];
    this.cache = new Map(); // prefixKey -> dfa state
    this.verifyCache = opts.verifyCache !== false;
    this.lastKeys = [];
    this.totals = { hits: 0, misses: 0 };
  }

  append(event) {
    this.events.push(event);
    return this;
  }

  retract(id) {
    const i = this.events.findIndex((e) => e.id === id);
    if (i < 0) throw new FlowError('EVENT_UNKNOWN', `no event with id ${id}`);
    this.events.splice(i, 1);
    return this;
  }

  replace(id, next) {
    const i = this.events.findIndex((e) => e.id === id);
    if (i < 0) throw new FlowError('EVENT_UNKNOWN', `no event with id ${id}`);
    this.events[i] = next;
    return this;
  }

  judge() {
    validateLog(this.events);
    const dfa = this.compiled.dfa;
    const events = this.events;
    const keys = prefixKeys(this.compiled.hash, events);
    this.lastKeys = keys;

    let reused = 0;
    for (let i = 0; i < keys.length; i++) {
      if (this.cache.has(keys[i])) reused = i + 1;
      else break;
    }

    let state = dfa.start;
    if (reused > 0) {
      state = this.cache.get(keys[reused - 1]);
      if (this.verifyCache) {
        let check = dfa.start;
        for (let i = 0; i < reused; i++) {
          const t = dfa.trans[check].get(events[i].role);
          if (t === undefined) {
            throw new FlowError('CACHE_POISON', 'cached state for unconsumable prefix');
          }
          check = t;
        }
        if (check !== state) {
          throw new FlowError('CACHE_POISON', 'cached state disagrees with replay');
        }
      }
    }

    let consumed = reused;
    for (let i = reused; i < events.length; i++) {
      const t = dfa.trans[state].get(events[i].role);
      if (t === undefined) break;
      state = t;
      consumed = i + 1;
      if (!this.cache.has(keys[i])) this.cache.set(keys[i], state);
    }

    this.totals.hits += reused;
    this.totals.misses += consumed - reused;

    const result = buildResult(this.compiled, events, state, consumed);
    result.cache = {
      reused,
      computed: consumed - reused,
      hitRate: events.length === 0 ? 1 : reused / events.length,
      totals: { ...this.totals },
    };
    return result;
  }
}

// ---------- compliance certificate ----------

function makeProof(compiled, events, judged) {
  return {
    dfaHash: compiled.hash,
    eventIds: events.slice(0, judged.consumed).map((e) => e.id),
    finalState: judged.finalState,
    verdict: judged.verdict,
  };
}

// independent verifier: recomputes everything from flow + log, never trusts CLI cache
function verifyProof(flowJson, events, proof) {
  const compiled = compileFlow(flowJson);
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'PROOF_INVALID' };
  if (proof.dfaHash !== compiled.hash) return { ok: false, reason: 'DFA_HASH_MISMATCH' };
  validateLog(events);
  const seq = proof.eventIds;
  if (!Array.isArray(seq) || seq.length > events.length) {
    return { ok: false, reason: 'EVENT_SEQUENCE' };
  }
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== events[i].id) return { ok: false, reason: 'EVENT_SEQUENCE' };
  }
  let state = compiled.dfa.start;
  for (let i = 0; i < seq.length; i++) {
    const t = compiled.dfa.trans[state].get(events[i].role);
    if (t === undefined) return { ok: false, reason: 'UNCONSUMABLE' };
    state = t;
  }
  if (state !== proof.finalState) return { ok: false, reason: 'FINAL_STATE_MISMATCH' };
  const verdict = seq.length === events.length && compiled.dfa.accept.has(state)
    ? 'accept'
    : 'reject';
  if (verdict !== proof.verdict) return { ok: false, reason: 'VERDICT_MISMATCH' };
  return { ok: true, verdict, finalState: state, dfaHash: compiled.hash };
}

module.exports = {
  ROLES,
  MAX_LOG,
  MAX_STATES,
  FlowError,
  parseFlow,
  subsetConstruction,
  minimizeDFA,
  canonicalize,
  dfaHash,
  shortestAcceptPath,
  compileFlow,
  validateLog,
  judgeEvents,
  Session,
  makeProof,
  verifyProof,
};
