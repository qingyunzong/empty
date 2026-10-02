import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAll } from '../src/machine.js';
import { makeEvent } from '../src/events.js';

// ---------------------------------------------------------------------------
// Independent reference state machine, written separately from src/machine.js
// (plain switch, no shared constants) for the enumeration cross-check.
// ---------------------------------------------------------------------------
function refStep(s, op) {
  switch (op) {
    case 'create':
      if (s.wo === null) s.wo = 'new';
      break;
    case 'assign':
      if (s.wo === 'new' || s.wo === 'assigned') {
        s.wo = 'assigned';
        s.team = 'T';
      }
      break;
    case 'start':
      if (s.wo === 'assigned') s.wo = 'in_progress';
      break;
    case 'complete':
      if (s.wo === 'in_progress') s.wo = 'completed';
      break;
    case 'cancel':
      if (s.wo === 'new' || s.wo === 'assigned' || s.wo === 'in_progress') s.wo = 'cancelled';
      break;
    case 'raise':
      if (s.alarm !== 'raised') s.alarm = 'raised';
      break;
    case 'clear':
      if (s.alarm === 'raised') s.alarm = 'cleared';
      break;
    default:
      throw new Error(`bad op ${op}`);
  }
  return s;
}

const ALARM_OPS = new Set(['raise', 'clear']);

function eventsFor(ops) {
  const vc = {};
  return ops.map((op, i) => {
    const seq = i + 1;
    vc.S = seq;
    return makeEvent({
      site: 'S',
      seq,
      vc: { ...vc },
      kind: ALARM_OPS.has(op) ? 'alarm' : 'wo',
      op,
      wo: 'W',
      alarm: 'AL',
      actor: 'u',
      team: op === 'assign' ? 'T' : null,
      interlock: false,
      ts: 't',
    });
  });
}

function summarize(state) {
  const wo = state.workorders.W;
  const al = state.alarms.AL;
  return {
    wo: wo ? wo.status : null,
    team: wo ? wo.team : null,
    alarm: al ? al.status : null,
  };
}

test('exhaustive enumeration of all op sequences up to n=9 against reference machine', () => {
  const OPS = ['create', 'assign', 'start', 'complete', 'cancel', 'raise', 'clear'];
  const init = { wo: null, team: null, alarm: null };
  const seen = new Set([JSON.stringify([init, init])]);
  let frontier = [{ ops: [], ref: init }];
  let sequences = 0;
  for (let depth = 1; depth <= 9; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (const op of OPS) {
        const ops = [...node.ops, op];
        sequences += 1;
        const ref = refStep({ ...node.ref }, op);
        const { state } = foldAll(eventsFor(ops));
        const got = summarize(state);
        assert.deepStrictEqual(
          got,
          ref,
          `divergence for sequence [${ops.join(',')}]`,
        );
        const key = JSON.stringify([ref, got]);
        if (!seen.has(key)) {
          seen.add(key);
          next.push({ ops, ref });
        }
      }
    }
    frontier = next;
  }
  // Sanity: the enumeration really explored the reachable graph (every
  // reachable state x every op) up to depth 9.
  assert.ok(sequences > 100, `expected >100 enumerated transitions, got ${sequences}`);
  assert.ok(seen.size > 10, `expected >10 reachable states, got ${seen.size}`);
});

test('complete -> start is rejected', () => {
  const { decisions, state } = foldAll(eventsFor(['create', 'assign', 'start', 'complete', 'start']));
  const last = decisions.at(-1);
  assert.equal(last.decision, 'rejected');
  assert.equal(last.reason, 'illegal-transition');
  assert.equal(state.workorders.W.status, 'completed');
});

test('cancel -> assign is rejected', () => {
  const { decisions, state } = foldAll(eventsFor(['create', 'cancel', 'assign']));
  const last = decisions.at(-1);
  assert.equal(last.decision, 'rejected');
  assert.equal(last.reason, 'illegal-transition');
  assert.equal(state.workorders.W.status, 'cancelled');
});

test('duplicate delivery inside the log is applied exactly once', () => {
  const evs = eventsFor(['create', 'assign']);
  const { state, duplicates } = foldAll([...evs, evs[0], evs[1], evs[0]]);
  assert.equal(duplicates.length, 3);
  assert.equal(Object.keys(state.applied).length, 2);
  assert.equal(state.workorders.W.status, 'assigned');
});
