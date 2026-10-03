'use strict';

// Metamorphic test: enumerate operation histories for up to 4 alarms and 2
// transactions, execute each history against the MVCC store and against the
// naive reference (plain arrays + predicate re-check at the commit point),
// and require identical op results, commit/rollback outcomes and final state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { RefStore } = require('../src/refstore');

const ALARMS = {
  a0: { id: 'a0', deviceId: 'd1', alarmTime: 10 },
  a1: { id: 'a1', deviceId: 'd1', alarmTime: 20 },
  a2: { id: 'a2', deviceId: 'd2', alarmTime: 10 },
  a3: { id: 'a3', deviceId: 'd2', alarmTime: 20 },
};
const IDS = Object.keys(ALARMS);

const WINDOWS = [
  { deviceId: 'd1', from: 0, to: 15 }, // covers a0
  { deviceId: 'd1', from: 15, to: 25 }, // covers a1
  { deviceId: 'd1', from: 0, to: 25 }, // covers a0, a1
  { deviceId: 'd2', from: 0, to: 25 }, // covers a2, a3
];

const realAdapter = {
  create: () => new Store(),
  begin: (s) => s.begin(),
  insert: (t, a) => t.insertAlarm(a),
  ack: (t, w) => t.ackWindow(w),
  commit: (t) => t.commit(),
  rollback: (t) => t.rollback(),
  dump: (s) => ({ alarms: s.listAlarms(), acks: s.listAcks() }),
};

const refAdapter = {
  create: () => new RefStore(),
  begin: (s) => s.begin(),
  insert: (t, a) => t.insertAlarm(a),
  ack: (t, w) => t.ackWindow(w),
  commit: (t) => t.commit(),
  rollback: (t) => t.rollback(),
  dump: (s) => ({ alarms: s.dumpAlarms(), acks: s.dumpAcks() }),
};

function runScript(adapter, script) {
  const store = adapter.create();
  const trace = [];
  const txns = {};

  for (const id of script.pre) {
    const t = adapter.begin(store);
    adapter.insert(t, { ...ALARMS[id] });
    adapter.commit(t);
  }

  const doOp = (name, op) => {
    const txn = txns[name];
    if (op.t === 'ins') {
      try {
        adapter.insert(txn, { ...ALARMS[op.id] });
        trace.push(`ins ${name} ${op.id} ok`);
      } catch (e) {
        trace.push(`ins ${name} ${op.id} ${e.code}`);
      }
    } else {
      const w = WINDOWS[op.w];
      const args = { ...w, by: `op-${name}`, at: name === 't1' ? 1000 : 2000, note: `note-${name}` };
      try {
        const r = adapter.ack(txn, args);
        trace.push(`ack ${name} w${op.w} count=${r.count}`);
      } catch (e) {
        trace.push(`ack ${name} w${op.w} ${e.code}`);
      }
    }
  };

  const endTxn = (name, how) => {
    try {
      adapter[how](txns[name]);
      trace.push(`${how} ${name} ok`);
    } catch (e) {
      trace.push(`${how} ${name} ${e.code}`);
    }
  };

  for (const step of script.steps) {
    if (step.k === 'begin') txns[step.tx] = adapter.begin(store);
    else if (step.k === 'op') doOp(step.tx, step.op);
    else endTxn(step.tx, step.how);
  }

  trace.push(JSON.stringify(adapter.dump(store)));
  return trace;
}

// All order-preserving shuffles of two op sequences.
function interleavings(p1, p2) {
  if (p1.length === 0) return [p2.map((op) => ({ tx: 't2', op }))];
  if (p2.length === 0) return [p1.map((op) => ({ tx: 't1', op }))];
  const out = [];
  for (const rest of interleavings(p1.slice(1), p2)) {
    out.push([{ tx: 't1', op: p1[0] }, ...rest]);
  }
  for (const rest of interleavings(p1, p2.slice(1))) {
    out.push([{ tx: 't2', op: p2[0] }, ...rest]);
  }
  return out;
}

function inWindow(alarmId, w) {
  const a = ALARMS[alarmId];
  const win = WINDOWS[w];
  return a.deviceId === win.deviceId && a.alarmTime >= win.from && a.alarmTime <= win.to;
}

function* txnPrograms(availIds) {
  yield [];
  for (const id of availIds) yield [{ t: 'ins', id }];
  for (let w = 0; w < WINDOWS.length; w++) yield [{ t: 'ack', w }];
  // Two-op programs: insert combined with an ack whose window contains the
  // new alarm (the interesting own-write/phantom interaction), in both orders.
  for (const id of availIds) {
    for (let w = 0; w < WINDOWS.length; w++) {
      if (!inWindow(id, w)) continue;
      yield [{ t: 'ins', id }, { t: 'ack', w }];
      yield [{ t: 'ack', w }, { t: 'ins', id }];
    }
  }
}

function* subsets(ids) {
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    yield ids.filter((_, i) => mask & (1 << i));
  }
}

function* generateScripts() {
  for (const pre of subsets(IDS)) {
    const avail = IDS.filter((id) => !pre.includes(id));
    const programs = [...txnPrograms(avail)];
    for (const p1 of programs) {
      for (const p2 of programs) {
        const ins1 = p1.find((op) => op.t === 'ins');
        const ins2 = p2.find((op) => op.t === 'ins');
        if (ins1 && ins2 && ins1.id === ins2.id) continue; // same id in both txns
        const ops1 = p1.map((op) => ({ k: 'op', tx: 't1', op }));
        const ops2 = p2.map((op) => ({ k: 'op', tx: 't2', op }));
        for (const e1 of ['commit', 'rollback']) {
          for (const e2 of ['commit', 'rollback']) {
            // serial: t1 fully before t2
            yield {
              pre,
              steps: [
                { k: 'begin', tx: 't1' }, ...ops1, { k: 'end', tx: 't1', how: e1 },
                { k: 'begin', tx: 't2' }, ...ops2, { k: 'end', tx: 't2', how: e2 },
              ],
            };
            // serial: t2 fully before t1
            yield {
              pre,
              steps: [
                { k: 'begin', tx: 't2' }, ...ops2, { k: 'end', tx: 't2', how: e2 },
                { k: 'begin', tx: 't1' }, ...ops1, { k: 'end', tx: 't1', how: e1 },
              ],
            };
          }
        }
        // concurrent: both begin, ops interleaved, then endings
        for (const inter of interleavings(p1, p2)) {
          const opSteps = inter.map(({ tx, op }) => ({ k: 'op', tx, op }));
          const endings = [
            [{ k: 'end', tx: 't1', how: 'commit' }, { k: 'end', tx: 't2', how: 'commit' }],
            [{ k: 'end', tx: 't2', how: 'commit' }, { k: 'end', tx: 't1', how: 'commit' }],
            [{ k: 'end', tx: 't1', how: 'commit' }, { k: 'end', tx: 't2', how: 'rollback' }],
            [{ k: 'end', tx: 't1', how: 'rollback' }, { k: 'end', tx: 't2', how: 'commit' }],
            [{ k: 'end', tx: 't1', how: 'rollback' }, { k: 'end', tx: 't2', how: 'rollback' }],
          ];
          for (const ends of endings) {
            yield { pre, steps: [{ k: 'begin', tx: 't1' }, { k: 'begin', tx: 't2' }, ...opSteps, ...ends] };
          }
        }
      }
    }
  }
}

test('enumerated histories match the naive reference implementation', (t) => {
  let histories = 0;
  let phantoms = 0;
  let commits = 0;
  const mismatches = [];
  for (const script of generateScripts()) {
    histories++;
    const realTrace = runScript(realAdapter, script);
    const refTrace = runScript(refAdapter, script);
    for (const line of realTrace) {
      if (line.includes('E_PHANTOM')) phantoms++;
      else if (line.startsWith('commit') && line.endsWith(' ok')) commits++;
    }
    if (JSON.stringify(realTrace) !== JSON.stringify(refTrace)) {
      mismatches.push({ script, realTrace, refTrace });
      if (mismatches.length >= 3) break;
    }
  }
  t.diagnostic(`histories=${histories} commits=${commits} phantomLines=${phantoms}`);
  assert.equal(histories > 20000, true, 'expected a substantial number of histories');
  assert.equal(phantoms > 0, true, 'expected some histories to hit E_PHANTOM');
  assert.deepEqual(mismatches, []);
});
