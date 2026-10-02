'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool, PoolError } = require('../lib/pool.js');
const { run } = require('../pool.js');

// ---------- A. deep capacity boundary ----------
test('A: deep-chain capacity boundary, deepest failing node reported', () => {
  const pool = new Pool();
  const DEPTH = 60;
  pool.addNode('n0', 1000);
  for (let i = 1; i < DEPTH; i++) {
    const p = Array.from({ length: i + 1 }, (_, k) => `n${k}`).join('/');
    pool.addNode(p, 1000 - i * 10); // limits shrink with depth
  }
  const leafPath = Array.from({ length: DEPTH }, (_, k) => `n${k}`).join('/');
  // Deepest node limit is 1000 - 59*10 = 410; reserve exactly 410 succeeds.
  pool.reserve(leafPath, 410, 'exact');
  assert.equal(pool.subtreeExposure('n0').held, 410);
  // One more unit must fail; deepest failing node is the leaf itself.
  assert.throws(
    () => pool.reserve(leafPath, 1, 'overflow'),
    (err) => {
      assert.equal(err.code, 'E_CAPACITY');
      assert.ok(err.message.includes(`n${DEPTH - 1}`), 'error names deepest node');
      return true;
    }
  );
  // Failed reserve leaves no residue anywhere.
  assert.equal(pool.subtreeExposure('n0').held, 410);
  // Mid-chain bottleneck: widen leaf by committing, then fail at a shallower node.
  pool.commit('exact');
  let err = null;
  try { pool.reserve(leafPath, 1000, 'big'); } catch (e) { err = e; }
  assert.equal(err.code, 'E_CAPACITY');
  // every node has spent=410 along chain; shallowest available = 1000-410=590 < 1000,
  // deepest failing node is still the leaf (limit 410, spent 410, available 0).
  assert.ok(err.message.includes(`n${DEPTH - 1}`));
});

// ---------- B. batch partial failure rolls back ----------
test('B: batchReserve third item fails, first two holds fully rolled back', () => {
  const pool = new Pool();
  pool.addNode('g', 100);
  pool.addNode('g/a', 60);
  pool.addNode('g/b', 60);
  const before = pool.subtreeExposure('g');
  assert.throws(
    () =>
      pool.batchReserve([
        { path: 'g/a', amount: 30, holdId: 'b1' },
        { path: 'g/b', amount: 30, holdId: 'b2' },
        { path: 'g/a', amount: 50, holdId: 'b3' }, // g/a avail 30 < 50 -> fail
      ]),
    (err) => err.code === 'E_CAPACITY'
  );
  const after = pool.subtreeExposure('g');
  assert.deepEqual(after, before, 'state identical to before the call');
  assert.equal(pool._resolve('g/a').held, 0);
  assert.equal(pool._resolve('g/b').held, 0);
  // Rolled-back holdIds are free again (hierarchical rollback to pre-call state).
  pool.batchReserve([
    { path: 'g/a', amount: 30, holdId: 'b1' },
    { path: 'g/b', amount: 30, holdId: 'b2' },
  ]);
  assert.equal(pool.subtreeExposure('g').held, 60);
});

// ---------- C. randomized differential test vs recursive reference ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference model: no incremental state; exposure computed by full recursion.
class RefNode {
  constructor(limit, parent) {
    this.limit = limit; this.held = 0; this.spent = 0; // capacity fields (chain-wide)
    this.ownHeld = 0; this.ownSpent = 0;             // exposure fields (this node only)
    this.parent = parent; this.children = new Map();
  }
}
// Reference exposure: full recursive sum of per-node own exposure (no increments).
function refExposure(node) {
  let e = node.ownHeld + node.ownSpent;
  for (const c of node.children.values()) e += refExposure(c);
  return e;
}

test('C: 300 random ops match recursive reference implementation', () => {
  const rnd = mulberry32(20261003);
  const pool = new Pool();
  const refRoot = new RefNode(Infinity, null);
  const refNodes = new Map([['', refRoot]]);
  const refHolds = new Map();
  const paths = [''];
  let holdSeq = 0;
  const liveHoldIds = [];

  const refReserve = (path, amount, id) => {
    const node = refNodes.get(path);
    for (let n = node; n; n = n.parent) {
      if (n.limit - n.held - n.spent < amount) return false;
    }
    for (let n = node; n; n = n.parent) n.held += amount;
    node.ownHeld += amount;
    refHolds.set(id, { node, amount, state: 'active' });
    return true;
  };

  for (let step = 0; step < 300; step++) {
    const kind = Math.floor(rnd() * 5);
    if (kind === 0 || paths.length < 2) {
      // addNode under a random existing node
      const parent = paths[Math.floor(rnd() * paths.length)];
      const p = (parent ? parent + '/' : '') + 'x' + paths.length + '_' + step;
      const limit = 50 + Math.floor(rnd() * 200);
      pool.addNode(p, limit);
      const parentRef = refNodes.get(parent);
      const rn = new RefNode(limit, parentRef);
      parentRef.children.set(p, rn);
      refNodes.set(p, rn);
      paths.push(p);
    } else if (kind === 1 || kind === 2) {
      // reserve on random path with random amount (sometimes over capacity)
      const p = paths[1 + Math.floor(rnd() * (paths.length - 1))];
      const amount = 1 + Math.floor(rnd() * 260);
      const id = 'h' + holdSeq++;
      let poolErr = null;
      try { pool.reserve(p, amount, id); } catch (e) { poolErr = e; }
      const ok = refReserve(p, amount, id);
      assert.equal(poolErr === null, ok, `step ${step}: reserve(${p}, ${amount}) agreement`);
      if (poolErr) assert.equal(poolErr.code, 'E_CAPACITY');
      else liveHoldIds.push(id);
    } else if (kind === 3 && liveHoldIds.length) {
      // commit or abort a random live hold in both models
      const idx = Math.floor(rnd() * liveHoldIds.length);
      const id = liveHoldIds.splice(idx, 1)[0];
      const h = refHolds.get(id);
      if (rnd() < 0.5) {
        pool.commit(id);
        for (let n = h.node; n; n = n.parent) { n.held -= h.amount; n.spent += h.amount; }
        h.node.ownHeld -= h.amount; h.node.ownSpent += h.amount;
      } else {
        pool.abort(id);
        for (let n = h.node; n; n = n.parent) n.held -= h.amount;
        h.node.ownHeld -= h.amount;
      }
      h.state = 'done';
    } else {
      // exposure query on random node vs full recursive reference
      const p = paths[Math.floor(rnd() * paths.length)];
      const got = pool.subtreeExposure(p).exposure;
      assert.equal(got, refExposure(refNodes.get(p)), `step ${step}: exposure(${p})`);
    }
  }
  // Final full-tree comparison at root.
  assert.equal(pool.subtreeExposure('').exposure, refExposure(refRoot));
});

// ---------- D. idempotent commit/abort ----------
test('D: repeated commit/abort are idempotent no-ops; unknown hold is E_ORPHAN_HOLD', () => {
  const pool = new Pool();
  pool.addNode('a', 100);
  pool.reserve('a', 40, 'h1');
  pool.reserve('a', 10, 'h2');

  const c1 = pool.commit('h1');
  assert.deepEqual(c1, { holdId: 'h1', state: 'committed' });
  const spentAfter = pool.subtreeExposure('a').spent;
  const c2 = pool.commit('h1'); // repeat: no-op, no double spend
  assert.equal(c2.idempotent, true);
  assert.equal(pool.subtreeExposure('a').spent, spentAfter);

  const a1 = pool.abort('h1'); // abort after commit: no-op, state stays committed
  assert.deepEqual(a1, { holdId: 'h1', state: 'committed', idempotent: true });
  assert.equal(pool.subtreeExposure('a').spent, spentAfter);

  pool.abort('h2');
  const r = pool.abort('h2'); // repeat abort: no-op
  assert.deepEqual(r, { holdId: 'h2', state: 'aborted', idempotent: true });
  assert.equal(pool.subtreeExposure('a').held, 0);

  assert.throws(() => pool.commit('nope'), (e) => e.code === 'E_ORPHAN_HOLD');
  assert.throws(() => pool.abort('nope'), (e) => e.code === 'E_ORPHAN_HOLD');
});

// ---------- CLI end-to-end ----------
test('CLI: exec --stats exits 0 with stats; failure exits 1 with stderr {code,message}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const okFile = path.join(dir, 'ok.jsonl');
  fs.writeFileSync(okFile, [
    '{"op":"addNode","path":"a","limit":100}',
    '{"op":"reserve","path":"a","amount":30,"holdId":"h1"}',
    '{"op":"commit","holdId":"h1"}',
  ].join('\n'));
  const mkIo = () => {
    const buf = { out: '', err: '' };
    const io = {
      stdout: { write: (s) => { buf.out += s; } },
      stderr: { write: (s) => { buf.err += s; } },
    };
    return { buf, io };
  };
  const okRun = mkIo();
  const okCode = run(['exec', okFile, '--stats'], okRun.io);
  assert.equal(okCode, 0);
  const statsLine = okRun.buf.out.trim().split('\n').pop();
  const stats = JSON.parse(statsLine).stats;
  assert.equal(stats.ops, 3);
  assert.equal(stats.spent, 30);

  const badFile = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(badFile, [
    '{"op":"addNode","path":"a","limit":10}',
    '{"op":"reserve","path":"a","amount":99,"holdId":"x"}',
  ].join('\n'));
  const badRun = mkIo();
  const badCode = run(['exec', badFile], badRun.io);
  assert.notEqual(badCode, 0, 'must exit non-zero');
  const errObj = JSON.parse(badRun.buf.err.trim());
  assert.equal(errObj.code, 'E_CAPACITY');
  assert.ok(typeof errObj.message === 'string');
});
