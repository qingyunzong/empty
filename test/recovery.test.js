'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, CrashError } = require('../engine');
const { Gateway } = require('../gateway');
const { TYPE } = require('../frame');

const BUDGET = 300;
const TTL = 50;

// Mixed scenario: reserves, retransmission, commit, release, expire, late commit.
const FRAMES = [
  { type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 120, seq: 1 },
  { type: TYPE.RESERVE, member: 'BOB', reqId: 1, amount: 200, seq: 1 },
  { type: TYPE.RESERVE, member: 'BOB', reqId: 1, amount: 200, seq: 1 }, // retransmission
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 1, amount: 100, seq: 2 },
  { type: TYPE.RELEASE, member: 'BOB', reqId: 1, amount: 50, seq: 2 },
  { type: TYPE.RESERVE, member: 'CAROL', reqId: 1, amount: 90, seq: 1 },
  { type: TYPE.EXPIRE, member: 'SYS', reqId: 0, amount: 60, seq: 1 },
  { type: TYPE.COMMIT, member: 'CAROL', reqId: 1, amount: 90, seq: 2 }, // late, expired at t=50
  { type: TYPE.RESERVE, member: 'DAVE', reqId: 1, amount: 40, seq: 1 },
];

function runAll(engine) {
  const gateway = new Gateway({ engine });
  const replies = [];
  for (const frame of FRAMES) replies.push(...gateway.handleFrame(frame));
  engine.finalize();
  return replies;
}

function comparable(replies) {
  return replies.map((r) => ({
    op: r.op, member: r.member, reqId: r.reqId, decision: r.decision,
    got: r.got, budget: r.budget, now: r.now, merkle: r.merkle, dup: !!r.dup,
  }));
}

function stateOf(engine) {
  return {
    now: engine.now,
    reservedActive: engine.reservedActive,
    committedTotal: engine.committedTotal,
    budgetLeft: engine.budgetLeft(),
    logLength: engine.log.length,
    root: engine.log.root(),
    flags: [...engine.exitFlags].sort(),
  };
}

const goldenEngine = new Engine({ budget: BUDGET, ttl: TTL });
const goldenReplies = runAll(goldenEngine);
const goldenState = stateOf(goldenEngine);
const nDecisions = goldenEngine.log.length;

test('recovery is unique for every crash point and every decision index', () => {
  assert.ok(nDecisions >= 8);
  for (const point of ['before_state', 'after_log', 'after_reply']) {
    for (let crashAt = 0; crashAt < nDecisions; crashAt++) {
      // run until the crash
      const crashed = new Engine({ budget: BUDGET, ttl: TTL, crashAt, crashPoint: point });
      const gw1 = new Gateway({ engine: crashed });
      let crashedAt = null;
      try {
        for (const frame of FRAMES) gw1.handleFrame(frame);
      } catch (err) {
        assert.ok(err instanceof CrashError, `expected CrashError, got ${err}`);
        crashedAt = err;
      }
      assert.ok(crashedAt, `expected crash at ${point}#${crashAt}`);
      assert.equal(crashedAt.point, point);
      assert.equal(crashedAt.index, crashAt);

      // recover from the persisted (write-ahead) log and reprocess everything
      const recovered = Engine.recover({ budget: BUDGET, ttl: TTL, records: crashed.log.records });
      const replies = runAll(recovered);

      assert.deepEqual(comparable(replies), comparable(goldenReplies),
        `replies diverge after crash at ${point}#${crashAt}`);
      assert.deepEqual(stateOf(recovered), goldenState,
        `state diverges after crash at ${point}#${crashAt}`);
    }
  }
});

test('log is append-only: recovery never rewrites existing records', () => {
  const crashed = new Engine({ budget: BUDGET, ttl: TTL, crashAt: 3, crashPoint: 'after_log' });
  const gw = new Gateway({ engine: crashed });
  try {
    for (const frame of FRAMES) gw.handleFrame(frame);
  } catch (err) { /* expected */ }
  const before = crashed.log.records.map((r) => JSON.stringify(r));
  const recovered = Engine.recover({ budget: BUDGET, ttl: TTL, records: crashed.log.records });
  runAll(recovered);
  const after = recovered.log.records.slice(0, before.length).map((r) => JSON.stringify(r));
  assert.deepEqual(after, before);
  assert.equal(recovered.log.length, goldenState.logLength);
});
