'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../index');

// --- deterministic PRNG -------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- independent reference implementation --------------------------------
// Recursive pull-based replay: state of a branch = parent state at its fork
// point, then its own events and deny-first merges in (ts, seq) order.
// Shares no code with index.js on purpose.
function referenceEval(events, asOf, branch, account) {
  const acc = account === undefined ? 'default' : account;
  const evs = events
    .filter((e) => e.ts < asOf.ts || (e.ts === asOf.ts && e.seq <= asOf.seq))
    .slice()
    .sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq) || (x.line - y.line));

  const fresh = () => ({ frozen: false, rule: null, rules: new Map(), members: new Map() });
  const copy = (s) => ({
    frozen: s.frozen,
    rule: s.rule,
    rules: new Map(s.rules),
    members: new Map([...s.members].map(([g, m]) => [g, new Map(m)])),
  });

  function applyOp(state, e) {
    const s = copy(state);
    if (e.op === 'rule') {
      s.rules.set(e.id, { id: e.id, group: e.group === undefined ? null : e.group });
    } else if (e.op === 'revoke') {
      s.rules.delete(e.rule);
      if (s.frozen && s.rule === e.rule) { s.frozen = false; s.rule = null; }
    } else if (e.op === 'join') {
      const member = e.account === undefined ? 'default' : e.account;
      if (!s.members.has(e.group)) s.members.set(e.group, new Map());
      s.members.get(e.group).set(member, true);
    } else if (e.op === 'trigger') {
      const evAcc = e.account === undefined ? 'default' : e.account;
      const def = s.rules.get(e.rule);
      if (!s.frozen && evAcc === acc && def && (def.group === null || (s.members.get(def.group) || new Map()).has(acc))) {
        s.frozen = true;
        s.rule = def.id;
      }
    }
    return s;
  }

  function combine(dst, src) {
    const s = copy(dst);
    for (const [id, def] of src.rules) if (!s.rules.has(id)) s.rules.set(id, def);
    for (const [g, m] of src.members) {
      if (!s.members.has(g)) s.members.set(g, new Map());
      for (const a of m.keys()) s.members.get(g).set(a, true);
    }
    if (!s.frozen && src.frozen) { s.frozen = true; s.rule = src.rule; }
    return s;
  }

  const memo = new Map();
  function stateOf(name, upto) {
    const key = name + ':' + upto;
    if (memo.has(key)) return memo.get(key);
    let state;
    let start;
    if (name === 'main') {
      state = fresh();
      start = 0;
    } else {
      const forkIdx = evs.findIndex((e, i) => i < upto && e.op === 'fork' && (e.branches || []).includes(name));
      if (forkIdx === -1) return null;
      state = stateOf(evs[forkIdx].branch === undefined ? 'main' : evs[forkIdx].branch, forkIdx);
      start = forkIdx + 1;
    }
    for (let i = start; i < upto; i++) {
      const e = evs[i];
      const br = e.branch === undefined ? 'main' : e.branch;
      if (e.op === 'merge' && br === name) {
        for (const src of e.sources) {
          const srcState = stateOf(src, i);
          if (srcState) state = combine(state, srcState);
        }
      } else if (br === name && e.op !== 'fork' && e.op !== 'merge') {
        state = applyOp(state, e);
      }
    }
    memo.set(key, state);
    return state;
  }

  const result = stateOf(branch, evs.length);
  return result === null ? null : { frozen: result.frozen, rule: result.rule };
}

// --- random log generator (<= 12 branches) -------------------------------
function genLog(rand) {
  const events = [];
  const branches = ['main'];
  const maxBranches = 1 + Math.floor(rand() * 12);
  const ruleIds = ['R1', 'R2', 'R3'];
  const groups = ['G1', 'G2'];
  const accounts = ['A', 'B'];
  const seqByTs = new Map();
  const createdAt = new Map([['main', { ts: 0, seq: 0 }]]);
  let ts = 0;
  let line = 0;

  const push = (ev) => {
    const seq = (seqByTs.get(ts) || 0) + 1;
    seqByTs.set(ts, seq);
    line += 1;
    events.push({ ...ev, ts, seq, line });
    if (ev.op === 'fork') {
      for (const name of ev.branches) createdAt.set(name, { ts, seq });
    }
  };

  const nEvents = 6 + Math.floor(rand() * 30);
  for (let i = 0; i < nEvents; i++) {
    ts += Math.floor(rand() * 3); // 0 keeps same ts -> exercises seq ordering
    const roll = rand();
    const branch = branches[Math.floor(rand() * branches.length)];
    if (roll < 0.18) {
      const id = ruleIds[Math.floor(rand() * ruleIds.length)];
      const ev = { op: 'rule', id, branch };
      if (rand() < 0.4) ev.group = groups[Math.floor(rand() * groups.length)];
      push(ev);
    } else if (roll < 0.30) {
      push({ op: 'join', account: accounts[Math.floor(rand() * accounts.length)], group: groups[Math.floor(rand() * groups.length)], branch });
    } else if (roll < 0.55) {
      const ev = { op: 'trigger', rule: ruleIds[Math.floor(rand() * ruleIds.length)], branch };
      if (rand() < 0.5) ev.account = accounts[Math.floor(rand() * accounts.length)];
      push(ev);
    } else if (roll < 0.68) {
      push({ op: 'revoke', rule: ruleIds[Math.floor(rand() * ruleIds.length)], branch });
    } else if (roll < 0.84 && branches.length < maxBranches) {
      const count = 1 + Math.floor(rand() * 2);
      const created = [];
      for (let k = 0; k < count && branches.length < maxBranches; k++) {
        const name = 'b' + branches.length;
        branches.push(name);
        created.push(name);
      }
      push({ op: 'fork', branch, branches: created });
    } else if (branches.length > 1) {
      const target = branches[Math.floor(rand() * branches.length)];
      const pool = branches.filter((b) => b !== target);
      const sources = [pool[Math.floor(rand() * pool.length)]];
      if (rand() < 0.3 && pool.length > 1) {
        const second = pool[Math.floor(rand() * pool.length)];
        if (!sources.includes(second)) sources.push(second);
      }
      push({ op: 'merge', branch: target, sources });
    } else {
      push({ op: 'trigger', rule: ruleIds[Math.floor(rand() * ruleIds.length)], branch });
    }
  }
  return { events, branches, createdAt, maxTs: ts };
}

function randomQueries(rand, log) {
  const queries = [];
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const asOf = { ts: Math.floor(rand() * (log.maxTs + 2)), seq: Math.floor(rand() * 4) };
    const existing = log.branches.filter((b) => {
      const c = log.createdAt.get(b);
      return c.ts < asOf.ts || (c.ts === asOf.ts && c.seq <= asOf.seq);
    });
    queries.push({
      asOf,
      branch: existing[Math.floor(rand() * existing.length)],
      account: ['default', 'A', 'B'][Math.floor(rand() * 3)],
    });
  }
  return queries;
}

test('acceptance 4: random logs (<=12 branches) match reference replay', () => {
  const SEEDS = 400;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const log = genLog(rand);
    assert.ok(log.branches.length <= 12, 'generator respects branch cap');
    for (const q of randomQueries(rand, log)) {
      const asOfStr = `${q.asOf.ts}:${q.asOf.seq}`;
      const actual = evaluate(log.events, { asOf: asOfStr, branch: q.branch, account: q.account });
      const expected = referenceEval(log.events, q.asOf, q.branch, q.account);
      assert.ok(expected !== null, `seed ${seed}: reference knows branch ${q.branch}`);
      assert.equal(
        actual.frozen, expected.frozen,
        `seed ${seed} asOf ${asOfStr} branch ${q.branch} account ${q.account}: frozen mismatch`
      );
      assert.equal(
        actual.rule, expected.rule,
        `seed ${seed} asOf ${asOfStr} branch ${q.branch} account ${q.account}: rule mismatch`
      );
      for (const ref of actual.explanation) {
        assert.ok(
          ref.ts < q.asOf.ts || (ref.ts === q.asOf.ts && ref.seq <= q.asOf.seq),
          `seed ${seed}: explanation event ${JSON.stringify(ref)} must not be later than as-of`
        );
      }
      if (actual.frozen) {
        assert.ok(actual.explanation.length > 0, `seed ${seed}: frozen verdict needs an explanation`);
        assert.ok(actual.explanation.some((e) => e.op === 'trigger'), `seed ${seed}: explanation needs the trigger`);
      }
    }
  }
});

test('acceptance 4b: same-ts heavy random logs match reference replay', () => {
  for (let seed = 1000; seed < 1100; seed++) {
    const rand = mulberry32(seed);
    const log = genLog(rand);
    // Collapse all events onto a single ts to stress seq ordering;
    // reassign seq by original causal (line) order.
    log.events.forEach((ev, i) => { ev.ts = 7; ev.seq = i + 1; });
    const q = { ts: 7, seq: 1 + Math.floor(rand() * 3) };
    const actual = evaluate(log.events, { asOf: `${q.ts}:${q.seq}`, branch: 'main' });
    const expected = referenceEval(log.events, q, 'main', 'default');
    assert.equal(actual.frozen, expected.frozen, `seed ${seed}: frozen mismatch on collapsed ts`);
    assert.equal(actual.rule, expected.rule, `seed ${seed}: rule mismatch on collapsed ts`);
  }
});
