'use strict';

// Offline credit-account freeze decision engine.
//
// Event model (one JSON object per line):
//   {ts, seq, op, branch?, ...}   ts/seq: non-negative integers, branch defaults to "main"
// State ops:
//   set     {key, value}                     set a risk fact
//   rule    {id, when:{key,op,value}, group?} define a risk rule (fires => freeze)
//   revoke  {id}                             revoke a rule; only affects evaluation after it
//   group   {id, parent?}                    trading group; rules inherit down the chain
//   account {group}                          place the credit account in a group
// History ops:
//   fork    {name}   create branch `name` from the event's branch at this position
//   merge   {name}   union branch `name`'s visible events (up to this position) into
//                    the event's branch; conflicting states resolve deny-first
//
// Errors: HistError with code E_FORK (branch structure) / E_TIME (time order) / E_PARSE.

const E_FORK = 'E_FORK';
const E_TIME = 'E_TIME';
const E_PARSE = 'E_PARSE';

class HistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistError';
    this.code = code;
  }
}

const STATE_OPS = new Set(['set', 'rule', 'revoke', 'group', 'account']);
const KNOWN_OPS = new Set([...STATE_OPS, 'fork', 'merge']);
const COND_OPS = new Set(['lt', 'lte', 'gt', 'gte', 'eq', 'ne']);

function cmpPos(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

function isNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function branchOf(ev) {
  return ev.branch === undefined ? 'main' : ev.branch;
}

function parseLog(text) {
  if (typeof text !== 'string') throw new HistError(E_PARSE, 'log must be a string');
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new HistError(E_PARSE, `line ${i + 1}: invalid JSON`);
    }
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev))
      throw new HistError(E_PARSE, `line ${i + 1}: event must be an object`);
    if (!isNonNegInt(ev.ts) || !isNonNegInt(ev.seq))
      throw new HistError(E_PARSE, `line ${i + 1}: ts/seq must be non-negative integers`);
    if (typeof ev.op !== 'string' || !KNOWN_OPS.has(ev.op))
      throw new HistError(E_PARSE, `line ${i + 1}: unknown op ${JSON.stringify(ev.op)}`);
    if (ev.branch !== undefined && typeof ev.branch !== 'string')
      throw new HistError(E_PARSE, `line ${i + 1}: branch must be a string`);
    validateStateOp(ev, i + 1);
    events.push(ev);
  }
  return events;
}

function validateStateOp(ev, lineNo) {
  const bad = (msg) => { throw new HistError(E_PARSE, `line ${lineNo}: ${msg}`); };
  switch (ev.op) {
    case 'set':
      if (typeof ev.key !== 'string' || !('value' in ev)) bad('set needs {key, value}');
      break;
    case 'rule': {
      if (typeof ev.id !== 'string') bad('rule needs string id');
      const w = ev.when;
      if (w === null || typeof w !== 'object' || typeof w.key !== 'string' ||
          !COND_OPS.has(w.op) || !('value' in w)) bad('rule needs when:{key,op,value}');
      if (ev.group !== undefined && typeof ev.group !== 'string') bad('rule group must be a string');
      break;
    }
    case 'revoke':
      if (typeof ev.id !== 'string') bad('revoke needs string id');
      break;
    case 'group':
      if (typeof ev.id !== 'string') bad('group needs string id');
      if (ev.parent !== undefined && typeof ev.parent !== 'string') bad('group parent must be a string');
      break;
    case 'account':
      if (typeof ev.group !== 'string') bad('account needs string group');
      break;
  }
}

function buildGraph(events) {
  const branches = new Map();
  branches.set('main', { name: 'main', from: null, forkPoint: null, events: [] });
  for (const ev of events) {
    const bname = branchOf(ev);
    const b = branches.get(bname);
    if (!b)
      throw new HistError(E_FORK, `event on unknown branch "${bname}" at ${ev.ts}:${ev.seq}`);
    if (b.forkPoint && cmpPos(ev, b.forkPoint) <= 0)
      throw new HistError(E_FORK,
        `event on branch "${bname}" at ${ev.ts}:${ev.seq} is not after its fork point ${b.forkPoint.ts}:${b.forkPoint.seq}`);
    const last = b.events[b.events.length - 1];
    if (last && cmpPos(ev, last) < 0)
      throw new HistError(E_TIME,
        `branch "${bname}": event ${ev.ts}:${ev.seq} precedes previous event ${last.ts}:${last.seq}`);
    b.events.push(ev);
    if (ev.op === 'fork') {
      if (typeof ev.name !== 'string' || ev.name === '')
        throw new HistError(E_FORK, `fork at ${ev.ts}:${ev.seq} missing branch name`);
      if (branches.has(ev.name))
        throw new HistError(E_FORK, `duplicate fork of branch "${ev.name}"`);
      branches.set(ev.name, { name: ev.name, from: bname, forkPoint: { ts: ev.ts, seq: ev.seq }, events: [] });
    } else if (ev.op === 'merge') {
      if (typeof ev.name !== 'string' || !branches.has(ev.name))
        throw new HistError(E_FORK, `merge of unknown branch "${ev.name}" at ${ev.ts}:${ev.seq}`);
      if (ev.name === bname)
        throw new HistError(E_FORK, `branch "${bname}" cannot merge itself`);
      const src = branches.get(ev.name);
      if (src.mergedInto !== undefined)
        throw new HistError(E_FORK, `branch "${ev.name}" merged more than once`);
      src.mergedInto = bname;
    }
  }
  return { branches };
}

// Events visible on `branchName` at position `pos` (inclusive): the branch's own
// events up to pos, its fork parent's events up to the fork point, and (recursively)
// the union of events from every branch merged in at a visible position.
function collectVisible(graph, branchName, pos) {
  const out = [];
  const seenEvents = new Set();
  const visited = new Set();
  const stack = [[branchName, pos]];
  while (stack.length > 0) {
    const [bname, bound] = stack.pop();
    const key = `${bname}@${bound.ts}:${bound.seq}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const b = graph.branches.get(bname);
    if (b.forkPoint) stack.push([b.from, b.forkPoint]);
    for (const ev of b.events) {
      if (cmpPos(ev, bound) > 0) break; // per-branch events are time-ordered
      if (ev.op === 'merge') {
        stack.push([ev.name, { ts: ev.ts, seq: ev.seq }]);
      } else if (STATE_OPS.has(ev.op) && !seenEvents.has(ev)) {
        seenEvents.add(ev);
        out.push(ev);
      }
    }
  }
  return out;
}

// Deterministic order for the merged union: (ts, seq), then an op rank chosen so
// that deny outcomes win ties (revoke before rule at the same position keeps the
// rule active), then branch name, then log order (sort is stable).
const OP_RANK = { set: 0, group: 1, account: 2, revoke: 3, rule: 4 };

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const c = cmpPos(a, b);
    if (c !== 0) return c;
    const ra = OP_RANK[a.op];
    const rb = OP_RANK[b.op];
    if (ra !== rb) return ra - rb;
    const ba = branchOf(a);
    const bb = branchOf(b);
    if (ba !== bb) return ba < bb ? -1 : 1;
    return 0;
  });
}

function checkCond(value, when) {
  if (value === undefined) return false;
  const target = when.value;
  switch (when.op) {
    case 'lt': return value < target;
    case 'lte': return value <= target;
    case 'gt': return value > target;
    case 'gte': return value >= target;
    case 'eq': return value === target;
    case 'ne': return value !== target;
    default: return false;
  }
}

function newState() {
  return {
    facts: new Map(),   // key -> {value, event}
    rules: new Map(),   // id -> {id, when, group, event, revoked, revokeEvent}
    groups: new Map(),  // id -> {parent, event}
    account: { name: 'default', event: null },
  };
}

function applyEvent(state, ev) {
  switch (ev.op) {
    case 'set':
      state.facts.set(ev.key, { value: ev.value, event: ev });
      break;
    case 'rule':
      state.rules.set(ev.id, {
        id: ev.id, when: ev.when, group: ev.group,
        event: ev, revoked: false, revokeEvent: null,
      });
      break;
    case 'revoke': {
      const r = state.rules.get(ev.id);
      if (r) { r.revoked = true; r.revokeEvent = ev; }
      break;
    }
    case 'group':
      state.groups.set(ev.id, { parent: ev.parent, event: ev });
      break;
    case 'account':
      state.account = { name: ev.group, event: ev };
      break;
  }
}

function appliesTo(state, ruleGroup) {
  if (ruleGroup === undefined) return true;
  let cur = state.account.name;
  const seen = new Set();
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === ruleGroup) return true;
    seen.add(cur);
    const g = state.groups.get(cur);
    cur = g ? g.parent : undefined;
  }
  return false;
}

function firedRules(state) {
  const out = [];
  for (const r of state.rules.values()) {
    if (r.revoked) continue;
    if (!appliesTo(state, r.group)) continue;
    const f = state.facts.get(r.when.key);
    if (f && checkCond(f.value, r.when)) out.push(r);
  }
  out.sort((a, b) => cmpPos(a.event, b.event) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// Fold the visible union into a state. `set` events that conflict at the same
// (ts, seq, key) across branches and produce the final value for that key are
// resolved deny-first: among the tied values, pick the first (in deterministic
// order) under which some rule fires; if none does, pick the first value.
function evaluate(visible) {
  const sorted = sortEvents(visible);
  const lastSet = new Map();     // fact key -> last set event in sorted order
  const setGroups = new Map();   // "ts:seq:key" -> {key, ts, seq, byValue: Map(value -> event), events: []}
  for (const ev of sorted) {
    if (ev.op !== 'set') continue;
    lastSet.set(ev.key, ev);
    const gk = `${ev.ts}:${ev.seq}:${ev.key}`;
    let g = setGroups.get(gk);
    if (!g) {
      g = { key: ev.key, ts: ev.ts, seq: ev.seq, byValue: new Map(), events: [] };
      setGroups.set(gk, g);
    }
    if (!g.byValue.has(ev.value)) g.byValue.set(ev.value, ev);
    g.events.push(ev);
  }
  const deferred = new Set();
  const conflictGroups = [];
  for (const g of setGroups.values()) {
    if (g.byValue.size > 1 && g.events.includes(lastSet.get(g.key))) {
      for (const ev of g.events) deferred.add(ev);
      conflictGroups.push(g);
    }
  }
  conflictGroups.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));

  const state = newState();
  for (const ev of sorted) {
    if (deferred.has(ev)) continue;
    applyEvent(state, ev);
  }
  for (const g of conflictGroups) {
    let chosen = null;
    for (const [value, ev] of g.byValue) {
      state.facts.set(g.key, { value, event: ev });
      if (firedRules(state).length > 0) { chosen = { value, event: ev }; break; }
      if (!chosen) chosen = { value, event: ev };
    }
    state.facts.set(g.key, chosen);
  }
  return state;
}

function formatEvent(ev) {
  return Object.assign({}, ev, { branch: branchOf(ev) });
}

// Minimal explanation for a freeze: the rule definition, the fact event that
// satisfies its condition, and (only when the rule is group-scoped) the account
// placement plus the group-inheritance chain linking them.
function explainFrozen(state, rule) {
  const events = [];
  const push = (e) => { if (e && !events.includes(e)) events.push(e); };
  push(rule.event);
  const fact = state.facts.get(rule.when.key);
  if (fact) push(fact.event);
  if (rule.group !== undefined) {
    push(state.account.event);
    let cur = state.account.name;
    const seen = new Set();
    while (cur !== rule.group && state.groups.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const g = state.groups.get(cur);
      push(g.event);
      cur = g.parent;
    }
  }
  return events.map(formatEvent);
}

function createHistory(text) {
  const events = parseLog(text);
  const graph = buildGraph(events);
  return { events, graph };
}

function query(history, opts) {
  const branch = opts.branch === undefined ? 'main' : opts.branch;
  if (!history.graph.branches.has(branch))
    throw new HistError(E_FORK, `unknown branch "${branch}"`);
  if (!isNonNegInt(opts.ts) || !isNonNegInt(opts.seq))
    throw new HistError(E_TIME, `invalid as-of position ${opts.ts}:${opts.seq}`);
  const visible = collectVisible(history.graph, branch, { ts: opts.ts, seq: opts.seq });
  const state = evaluate(visible);
  const fired = firedRules(state);
  if (fired.length > 0)
    return { frozen: true, rule: fired[0].id, explain: explainFrozen(state, fired[0]) };
  // Not frozen: if a rule's condition holds but the rule was revoked, the revoke
  // event is the minimal explanation for the negative decision.
  const suppressed = [];
  for (const r of state.rules.values()) {
    if (!r.revoked || !r.revokeEvent) continue;
    if (!appliesTo(state, r.group)) continue;
    const f = state.facts.get(r.when.key);
    if (f && checkCond(f.value, r.when)) suppressed.push(r);
  }
  if (suppressed.length > 0) {
    suppressed.sort((a, b) => cmpPos(a.revokeEvent, b.revokeEvent));
    return { frozen: false, rule: null, explain: [formatEvent(suppressed[0].revokeEvent)] };
  }
  return { frozen: false, rule: null, explain: [] };
}

module.exports = {
  E_FORK, E_TIME, E_PARSE,
  HistError,
  parseLog,
  buildGraph,
  collectVisible,
  evaluate,
  createHistory,
  query,
};
