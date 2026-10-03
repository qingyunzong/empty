import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Monitor } from '../src/monitor.js';

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
  return path.join(dir, 'ops.jsonl');
}

// Canonical fixture: committed triangle + two further ops (no commit needed
// for durability; commit is an explicit checkpoint marker).
// seq: 1 add(1,2) 2 add(2,3) 3 add(3,1) 4 commit 5 add(3,4) 6 add(4,5)
function buildFixture(log) {
  const m = new Monitor(log);
  m.addEdge(1, 2);
  m.addEdge(2, 3);
  m.addEdge(3, 1);
  m.commit();
  m.addEdge(3, 4);
  m.addEdge(4, 5);
  return m;
}

// Hash of the full fixture graph: triangle 1-2-3 plus tail 3-4-5.
const FULL_HASH = (() => {
  const m = new Monitor(tmpLog());
  for (const [u, v] of [[1, 2], [2, 3], [3, 1], [3, 4], [4, 5]]) m.addEdge(u, v);
  return m.stateHash();
})();

// Hash of the fixture graph without the last record (add 4,5).
const TRUNCATED_HASH = (() => {
  const m = new Monitor(tmpLog());
  for (const [u, v] of [[1, 2], [2, 3], [3, 1], [3, 4]]) m.addEdge(u, v);
  return m.stateHash();
})();

test('complete records survive reopen and replay to the same state', () => {
  const log = tmpLog();
  buildFixture(log);
  const reopened = new Monitor(log); // auto-recover on open
  assert.deepEqual(reopened.graph.edges(), [[1, 2], [1, 3], [2, 3], [3, 4], [4, 5]]);
  assert.deepEqual(reopened.queryBridges(), [[3, 4], [4, 5]]);
  assert.deepEqual(reopened.queryArticulation(), [3, 4]);
  assert.equal(reopened.stateHash(), FULL_HASH);
});

test('in-memory queries match a fresh replay from the log', () => {
  const log = tmpLog();
  const m = buildFixture(log);
  const replayed = new Monitor(log);
  assert.deepEqual(replayed.queryBridges(), m.queryBridges());
  assert.deepEqual(replayed.queryArticulation(), m.queryArticulation());
  assert.equal(replayed.stateHash(), m.stateHash());
});

test('fault point after_append: torn del_edge half record is discarded, not applied', () => {
  const log = tmpLog();
  const m = buildFixture(log);
  assert.equal(m.crashSim('after_append'), 'OK');
  const r = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(r.applied, 5); // the five complete add_edge records
  assert.equal(r.discarded, 1); // the torn half record
  assert.equal(r.state_hash, FULL_HASH); // edge (1,2) NOT deleted
  const after = new Monitor(log);
  assert.equal(after.graph.hasEdge(1, 2), true);
});

test('fault point before_fsync: truncated tail of last record is discarded', () => {
  const log = tmpLog();
  const m = buildFixture(log);
  assert.equal(m.crashSim('before_fsync'), 'OK');
  const r = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(r.applied, 4); // add(4,5) lost its tail bytes before fsync
  assert.equal(r.discarded, 1);
  assert.equal(r.state_hash, TRUNCATED_HASH);
});

test('fault point after_index_commit: torn commit record confirms nothing', () => {
  const log = tmpLog();
  const m = buildFixture(log);
  assert.equal(m.crashSim('after_index_commit'), 'OK');
  const r = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(r.applied, 5); // data records are intact and replayed
  assert.equal(r.discarded, 1); // the torn commit half record
  assert.equal(r.state_hash, FULL_HASH);
});

test('all three fault points recover deterministically', () => {
  const expected = {
    after_append: { applied: 5, discarded: 1, state_hash: FULL_HASH },
    before_fsync: { applied: 4, discarded: 1, state_hash: TRUNCATED_HASH },
    after_index_commit: { applied: 5, discarded: 1, state_hash: FULL_HASH },
  };
  for (const [point, want] of Object.entries(expected)) {
    for (let rep = 0; rep < 2; rep += 1) {
      const log = tmpLog();
      const m = buildFixture(log);
      m.crashSim(point);
      const r = new Monitor(log, { autoRecover: false }).recover();
      assert.deepEqual(r, want, `point=${point} rep=${rep}`);
      // recovery is idempotent: a second recover reports nothing new
      const again = new Monitor(log, { autoRecover: false }).recover();
      assert.deepEqual(again, { applied: want.applied, discarded: 0, state_hash: want.state_hash });
    }
  }
});

test('recover on empty file: applied=0 discarded=0, hash of empty graph', () => {
  const log = tmpLog();
  fs.writeFileSync(log, '');
  const r = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(r.applied, 0);
  assert.equal(r.discarded, 0);
  const empty = new Monitor(tmpLog());
  assert.equal(r.state_hash, empty.stateHash());
});

test('recover on missing file behaves like an empty log', () => {
  const log = tmpLog(); // never created
  const r = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(r.applied, 0);
  assert.equal(r.discarded, 0);
});

test('crash_sim on an empty log is a safe no-op / discardable tear', () => {
  for (const point of ['after_append', 'before_fsync', 'after_index_commit']) {
    const log = tmpLog();
    fs.writeFileSync(log, '');
    const m = new Monitor(log);
    assert.equal(m.crashSim(point), 'OK');
    const r = new Monitor(log, { autoRecover: false }).recover();
    assert.equal(r.applied, 0);
    assert.equal(r.state_hash, new Monitor(tmpLog()).stateHash());
  }
});

test('corrupt complete record (bad crc) raises PERSIST_CORRUPT', () => {
  const log = tmpLog();
  const m = new Monitor(log);
  m.addEdge(1, 2);
  m.commit();
  fs.appendFileSync(log, '{"seq":3,"op":"add_edge","u":9,"v":9,"crc":"deadbeefdeadbeef"}\n');
  assert.throws(() => new Monitor(log), /PERSIST_CORRUPT/);
});

test('garbage bytes in the middle of the log raise PERSIST_CORRUPT', () => {
  const log = tmpLog();
  const m = new Monitor(log);
  m.addEdge(1, 2);
  m.commit();
  fs.appendFileSync(log, 'this is not json\n');
  assert.throws(() => new Monitor(log, { autoRecover: false }).recover(), /PERSIST_CORRUPT/);
});

test('duplicate edge via Monitor is OK and replays idempotently', () => {
  const log = tmpLog();
  const m = new Monitor(log);
  assert.equal(m.addEdge(1, 2), 'OK');
  assert.equal(m.addEdge(2, 1), 'OK'); // duplicate, reversed order
  m.commit();
  const r = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(r.applied, 2);
  assert.deepEqual(new Monitor(log).graph.edges(), [[1, 2]]);
});

test('invalid vertices and self-loops are rejected with INVALID_INPUT', () => {
  const m = new Monitor(tmpLog());
  for (const bad of [[-1, 2], [1.5, 2], [NaN, 2], [3, 3], ['a', 2]]) {
    assert.equal(m.addEdge(bad[0], bad[1]), 'INVALID_INPUT');
    assert.equal(m.delEdge(bad[0], bad[1]), 'INVALID_INPUT');
  }
});

test('deleting an unknown edge returns NO_SUCH_EDGE and writes nothing', () => {
  const log = tmpLog();
  const m = new Monitor(log);
  m.addEdge(1, 2);
  assert.equal(m.delEdge(2, 3), 'NO_SUCH_EDGE');
  assert.equal(m.delEdge(7, 8), 'NO_SUCH_EDGE');
  assert.equal(m.graph.edgeCount(), 1);
});

test('deleted edge re-added then committed replays to the same state', () => {
  const log = tmpLog();
  const m = new Monitor(log);
  m.addEdge(1, 2);
  m.addEdge(2, 3);
  m.commit();
  m.delEdge(1, 2);
  m.addEdge(1, 2);
  m.commit();
  const replayed = new Monitor(log);
  assert.deepEqual(replayed.graph.edges(), [[1, 2], [2, 3]]);
  assert.equal(replayed.stateHash(), m.stateHash());
});
