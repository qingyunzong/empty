'use strict';

// Acceptance 4: random histories with up to 12 branches, cross-checked against
// an independently written reference replay.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, query } = require('../lib');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['marginRatio', 'exposure', 'vol'];
const CONDS = ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'];
const GROUPS = ['G0', 'G1', 'G2'];

function genLog(rng) {
  const events = [];
  const clocks = new Map([['main', [0, 0]]]);
  const branches = ['main'];
  const merged = new Set();
  const definedGroups = [];
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const advance = (b) => {
    const c = clocks.get(b);
    if (rng() < 0.5) { c[0] += 1 + Math.floor(rng() * 3); c[1] = 0; } else { c[1] += 1; }
    return { ts: c[0], seq: c[1] };
  };
  const setEv = (b, pos) => ({ ...pos, branch: b, op: 'set', key: pick(KEYS), value: Math.floor(rng() * 6) });
  const nEvents = 5 + Math.floor(rng() * 40);
  for (let i = 0; i < nEvents; i++) {
    const b = pick(branches);
    const pos = advance(b);
    const roll = rng();
    let ev;
    if (roll < 0.34) {
      ev = setEv(b, pos);
    } else if (roll < 0.50) {
      ev = { ...pos, branch: b, op: 'rule', id: 'R' + (1 + Math.floor(rng() * 4)),
             when: { key: pick(KEYS), op: pick(CONDS), value: Math.floor(rng() * 6) } };
      if (definedGroups.length > 0 && rng() < 0.4) ev.group = pick(definedGroups);
    } else if (roll < 0.60) {
      ev = { ...pos, branch: b, op: 'revoke', id: 'R' + (1 + Math.floor(rng() * 4)) };
    } else if (roll < 0.68 && branches.length < 12) {
      const name = 'b' + branches.length;
      ev = { ...pos, branch: b, op: 'fork', name };
      branches.push(name);
      clocks.set(name, [pos.ts, pos.seq]);
    } else if (roll < 0.78) {
      const cand = branches.filter((x) => x !== b && !merged.has(x));
      if (cand.length > 0) {
        const name = pick(cand);
        merged.add(name);
        ev = { ...pos, branch: b, op: 'merge', name };
      } else {
        ev = setEv(b, pos);
      }
    } else if (roll < 0.86) {
      const id = GROUPS[definedGroups.length % GROUPS.length];
      ev = { ...pos, branch: b, op: 'group', id };
      if (definedGroups.length > 0 && rng() < 0.7) ev.parent = pick(definedGroups);
      if (!definedGroups.includes(id)) definedGroups.push(id);
    } else if (roll < 0.92 && definedGroups.length > 0) {
      ev = { ...pos, branch: b, op: 'account', group: pick(definedGroups) };
    } else {
      ev = setEv(b, pos);
    }
    events.push(ev);
  }
  return { events, branches, clocks };
}

// ---- Reference replay (independent implementation of the same spec) ----

function refDecide(events, branch, ts, seq) {
  const bOf = (e) => (e.branch === undefined ? 'main' : e.branch);
  const leq = (e) => e.ts < ts || (e.ts === ts && e.seq <= seq);
  const byBranch = new Map();
  const forkOf = new Map();
  for (const e of events) {
    const b = bOf(e);
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(e);
    if (e.op === 'fork') forkOf.set(e.name, { from: b, ts: e.ts, seq: e.seq });
  }
  const visible = [];
  const seenEv = new Set();
  const seenKey = new Set();
  const visit = (b, bts, bseq) => {
    const k = b + '@' + bts + ':' + bseq;
    if (seenKey.has(k)) return;
    seenKey.add(k);
    const f = forkOf.get(b);
    if (f) visit(f.from, f.ts, f.seq);
    for (const e of byBranch.get(b) || []) {
      if (!(e.ts < bts || (e.ts === bts && e.seq <= bseq))) continue;
      if (e.op === 'merge') { visit(e.name, e.ts, e.seq); continue; }
      if (e.op === 'fork') continue;
      if (seenEv.has(e)) continue;
      seenEv.add(e);
      visible.push(e);
    }
  };
  visit(branch, ts, seq);

  const RANK = { set: 0, group: 1, account: 2, revoke: 3, rule: 4 };
  const sorted = visible.slice().sort((a, c) => {
    if (a.ts !== c.ts) return a.ts - c.ts;
    if (a.seq !== c.seq) return a.seq - c.seq;
    if (RANK[a.op] !== RANK[c.op]) return RANK[a.op] - RANK[c.op];
    const ba = bOf(a), bc = bOf(c);
    return ba < bc ? -1 : ba > bc ? 1 : 0;
  });

  // conflict groups for set at identical (ts, seq, key)
  const lastSet = new Map();
  const gmap = new Map();
  for (const e of sorted) {
    if (e.op !== 'set') continue;
    lastSet.set(e.key, e);
    const k = e.ts + ':' + e.seq + ':' + e.key;
    if (!gmap.has(k)) gmap.set(k, { key: e.key, ts: e.ts, seq: e.seq, values: new Map(), evs: [] });
    const g = gmap.get(k);
    if (!g.values.has(e.value)) g.values.set(e.value, e);
    g.evs.push(e);
  }
  const deferred = new Set();
  const conflicts = [];
  for (const g of gmap.values()) {
    if (g.values.size > 1 && g.evs.indexOf(lastSet.get(g.key)) !== -1) {
      g.evs.forEach((e) => deferred.add(e));
      conflicts.push(g);
    }
  }
  conflicts.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));

  const facts = new Map();
  const rules = new Map();
  const groups = new Map();
  let account = { name: 'default', event: null };
  const apply = (e) => {
    if (e.op === 'set') facts.set(e.key, { value: e.value, event: e });
    else if (e.op === 'rule') rules.set(e.id, { id: e.id, when: e.when, group: e.group, event: e, revoked: false, revokeEvent: null });
    else if (e.op === 'revoke') { const r = rules.get(e.id); if (r) { r.revoked = true; r.revokeEvent = e; } }
    else if (e.op === 'group') groups.set(e.id, { parent: e.parent, event: e });
    else if (e.op === 'account') account = { name: e.group, event: e };
  };
  for (const e of sorted) if (!deferred.has(e)) apply(e);

  const cond = (v, w) => {
    if (v === undefined) return false;
    if (w.op === 'lt') return v < w.value;
    if (w.op === 'lte') return v <= w.value;
    if (w.op === 'gt') return v > w.value;
    if (w.op === 'gte') return v >= w.value;
    if (w.op === 'eq') return v === w.value;
    if (w.op === 'ne') return v !== w.value;
    return false;
  };
  const applies = (rg) => {
    if (rg === undefined) return true;
    let cur = account.name;
    const seen = new Set();
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === rg) return true;
      seen.add(cur);
      const g = groups.get(cur);
      cur = g ? g.parent : undefined;
    }
    return false;
  };
  const fired = () => {
    const out = [];
    for (const r of rules.values()) {
      if (r.revoked || !applies(r.group)) continue;
      const f = facts.get(r.when.key);
      if (f && cond(f.value, r.when)) out.push(r);
    }
    out.sort((a, b) => (a.event.ts - b.event.ts) || (a.event.seq - b.event.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  };

  for (const g of conflicts) {
    let chosen = null;
    for (const [value, ev] of g.values) {
      facts.set(g.key, { value, event: ev });
      if (fired().length > 0) { chosen = { value, event: ev }; break; }
      if (!chosen) chosen = { value, event: ev };
    }
    facts.set(g.key, chosen);
  }

  const fmt = (e) => Object.assign({}, e, { branch: bOf(e) });
  const win = fired();
  if (win.length > 0) {
    const r = win[0];
    const ex = [];
    const push = (e) => { if (e && ex.indexOf(e) === -1) ex.push(e); };
    push(r.event);
    const f = facts.get(r.when.key);
    if (f) push(f.event);
    if (r.group !== undefined) {
      push(account.event);
      let cur = account.name;
      const seen = new Set();
      while (cur !== r.group && groups.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        push(groups.get(cur).event);
        cur = groups.get(cur).parent;
      }
    }
    return { frozen: true, rule: r.id, explain: ex.map(fmt) };
  }
  const supp = [];
  for (const r of rules.values()) {
    if (!r.revoked || !r.revokeEvent || !applies(r.group)) continue;
    const f = facts.get(r.when.key);
    if (f && cond(f.value, r.when)) supp.push(r);
  }
  if (supp.length > 0) {
    supp.sort((a, b) => (a.revokeEvent.ts - b.revokeEvent.ts) || (a.revokeEvent.seq - b.revokeEvent.seq));
    return { frozen: false, rule: null, explain: [fmt(supp[0].revokeEvent)] };
  }
  return { frozen: false, rule: null, explain: [] };
}

const norm = (r) => JSON.stringify({
  frozen: r.frozen,
  rule: r.rule,
  explain: r.explain.map((e) => JSON.stringify(e)).sort(),
});

test('random histories (<=12 branches) match reference replay', () => {
  const ITERATIONS = 400;
  for (let seed = 1; seed <= ITERATIONS; seed++) {
    const rng = mulberry32(seed);
    const { events, branches, clocks } = genLog(rng);
    const text = events.map((e) => JSON.stringify(e)).join('\n');
    const history = createHistory(text);
    let maxTs = 0;
    for (const c of clocks.values()) maxTs = Math.max(maxTs, c[0]);
    for (let q = 0; q < 4; q++) {
      const branch = branches[Math.floor(rng() * branches.length)];
      const ts = Math.floor(rng() * (maxTs + 2));
      const seq = Math.floor(rng() * 5);
      const got = query(history, { branch, ts, seq });
      const want = refDecide(events, branch, ts, seq);
      assert.equal(
        norm(got), norm(want),
        `seed=${seed} query=${branch}@${ts}:${seq}\nlog:\n${text}`,
      );
    }
  }
});
