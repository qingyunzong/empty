'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/engine');
const { Chain } = require('../src/chain');
const { encodeFrame, FrameParser } = require('../src/frame');
const { buildFrames, runFrames, interleavings } = require('./helpers');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
}

test('1. replay of the same opId is deduplicated with identical ack', () => {
  const { frames } = buildFrames([
    { actor: 'alice', cmd: 'set', args: { key: 'x', value: 1 } },
    { actor: 'alice', cmd: 'inc', args: { key: 'n', n: 5 } },
  ]);
  const engine = new Engine(null);
  const [r1] = engine.process(frames[0], encodeFrame(frames[0]));
  const [r2] = engine.process(frames[0], encodeFrame(frames[0])); // retransmission
  assert.equal(r1.status, 'applied');
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.ack, r1.ack);
  assert.equal(engine.chain.count, 1);
  engine.process(frames[1], encodeFrame(frames[1]));
  engine.process(frames[1], encodeFrame(frames[1]));
  assert.equal(engine.chain.count, 2);
});

test('2. out-of-order prevHash is buffered, then linearized to the same root', () => {
  const ops = [
    { actor: 'alice', cmd: 'set', args: { key: 'a', value: 1 } },
    { actor: 'bob', cmd: 'set', args: { key: 'b', value: 2 } },
    { actor: 'carol', cmd: 'inc', args: { key: 'c', n: 3 } },
  ];
  const { frames, ref } = buildFrames(ops);
  const engine = runFrames(frames, { order: [2, 0, 1] }); // seq 3 arrives first
  assert.equal(engine.chain.count, 3);
  assert.equal(engine.root, ref.root);
  const statuses = engine.results.map((r) => r.status);
  assert.equal(statuses[0], 'buffered');
  assert.deepEqual(engine.chain.entries.map((e) => e.seq), [1, 2, 3]);
});

test('3. undo of an executed command, then undo of the undo, appends inverse entries', () => {
  const setOp = { actor: 'alice', cmd: 'set', args: { key: 'k', value: 42 } };
  const { frames: f1 } = buildFrames([setOp]);
  const engine = new Engine(null);
  engine.process(f1[0], encodeFrame(f1[0]));
  assert.deepEqual(engine.chain.state, { k: 42 });

  const undo1 = { opId: 'd1'.padStart(32, '0'), actor: 'alice', cmd: 'undo', args: { target: f1[0].opId }, prevHash: engine.root, seq: 2, leaseUntil: 1e9 };
  engine.process(undo1, encodeFrame(undo1));
  assert.deepEqual(engine.chain.state, {});
  const undoEntry = engine.chain.entries[1];
  assert.equal(undoEntry.kind, 'undo');
  assert.equal(undoEntry.proof.targetHash, engine.chain.entries[0].hash);

  const undo2 = { opId: 'd2'.padStart(32, '0'), actor: 'alice', cmd: 'undo', args: { target: undo1.opId }, prevHash: engine.root, seq: 3, leaseUntil: 1e9 };
  engine.process(undo2, encodeFrame(undo2));
  assert.deepEqual(engine.chain.state, { k: 42 }); // inverse of inverse re-applies
  assert.equal(engine.chain.count, 3); // log only grows, never truncated
  const proof = engine.chain.entries[2].proof;
  assert.equal(proof.targetHash, undoEntry.hash);
  assert.equal(proof.preStateHash, engine.chain.entries[0].stateHash);
});

test('4. recovery from all three crash points keeps index consistent with log', () => {
  const ops = [
    { actor: 'alice', cmd: 'set', args: { key: 'x', value: 1 } },
    { actor: 'bob', cmd: 'inc', args: { key: 'y', n: 2 } },
  ];
  const { frames, ref } = buildFrames(ops);

  // crash point 1: after frame parse, before any persistence
  {
    const dir = tmpdir();
    const engine = new Engine(dir);
    engine.clock += 1; // frame parsed, clock ticked, nothing persisted
    assert.equal(fs.existsSync(path.join(dir, 'audit.log')), false);
    const recovered = runFrames(frames, { dir });
    assert.equal(recovered.root, ref.root);
  }

  // crash point 2: after log flush, before index update
  {
    const dir = tmpdir();
    const engine = new Engine(dir);
    engine.chain.hooks.afterLogFlush = () => {
      fs.rmSync(path.join(dir, 'index.json'), { force: true });
      throw new Error('simulated crash after log flush');
    };
    assert.throws(() => engine.process(frames[0], encodeFrame(frames[0])), /simulated crash/);
    const recovered = runFrames(frames, { dir }); // must not duplicate seq 1
    assert.equal(recovered.chain.count, 2);
    assert.equal(recovered.root, ref.root);
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(idx.tip, recovered.root);
    assert.equal(idx.count, 2);
  }

  // crash point 3: after index update (fully consistent), then continue
  {
    const dir = tmpdir();
    const engine = new Engine(dir);
    engine.chain.hooks.afterIndexUpdate = () => {
      throw new Error('simulated crash after index update');
    };
    assert.throws(() => engine.process(frames[0], encodeFrame(frames[0])), /simulated crash/);
    const recovered = runFrames(frames, { dir });
    assert.equal(recovered.chain.count, 2);
    assert.equal(recovered.root, ref.root);
  }
});

test('5. all interleavings of <=8 ops match the reference serializer', () => {
  const perActor = [
    ['alice', [{ cmd: 'set', args: { key: 'a', value: 1 } }, { cmd: 'inc', args: { key: 'n', n: 1 } }, { cmd: 'set', args: { key: 'a', value: 3 } }]],
    ['bob', [{ cmd: 'set', args: { key: 'b', value: 2 } }, { cmd: 'inc', args: { key: 'n', n: 10 } }, { cmd: 'del', args: { key: 'b' } }]],
    ['carol', [{ cmd: 'inc', args: { key: 'n', n: 100 } }, { cmd: 'set', args: { key: 'c', value: 7 } }]],
  ];
  const ops = [];
  const queues = perActor.map(([actor, cmds]) => cmds.map((c) => ({ actor, ...c })));
  // serial seq order: alice ops, then bob ops, then carol ops
  for (const q of queues) for (const op of q) ops.push(op);
  const { frames, ref } = buildFrames(ops);
  assert.equal(ops.length, 8);

  // map each actor's queue to its frames (seq order within actor)
  const actorFrames = queues.map((q) => q.map((op) => frames[ops.indexOf(op)]));
  let checked = 0;
  for (const order of interleavings(actorFrames)) {
    const engine = new Engine(null);
    for (const f of order) engine.process(f, encodeFrame(f));
    const summary = engine.finalize();
    assert.equal(summary.pending.length, 0);
    assert.equal(engine.chain.count, 8);
    assert.equal(engine.root, ref.root, `root mismatch for order ${order.map((f) => f.seq)}`);
    assert.deepEqual(engine.chain.state, ref.chain.state);
    checked += 1;
  }
  assert.equal(checked, 560); // 8! / (3! 3! 2!)
});
