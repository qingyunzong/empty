'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool, PoolError } = require('../pool.js');
const { runCli } = require('../cli.js');

function buildChain(limits) {
  // limits: [['root', 1000], ['root/a', 500], ...]
  const pool = new Pool();
  for (const [p, limit] of limits) pool.run({ op: 'add', path: p, limit });
  return pool;
}

test('A: deep capacity boundary, deepest failing node reported', () => {
  const pool = buildChain([
    ['root', 1000],
    ['root/a', 500],
    ['root/a/b', 100],
    ['root/a/b/c', 300],
    ['root/a/b/c/d', 50],
  ]);

  // Exact boundary at leaf succeeds.
  pool.run({ op: 'reserve', path: 'root/a/b/c/d', amount: 50, holdId: 'h-exact' });
  assert.equal(pool.subtreeExposure('root/a/b/c/d').held, 50);

  // Leaf now full: failure node is the leaf itself.
  assert.throws(
    () => pool.run({ op: 'reserve', path: 'root/a/b/c/d', amount: 1, holdId: 'h-x1' }),
    (err) => err.code === 'E_CAPACITY' && err.message.includes('root/a/b/c/d')
  );

  // Intermediate node b (limit 100) is the only failing node on the path:
  // c has 300, d has 50 already held but amount 150 > b's 100 available... use fresh path amounts.
  const pool2 = buildChain([
    ['root', 1000],
    ['root/a', 500],
    ['root/a/b', 100],
    ['root/a/b/c', 300],
    ['root/a/b/c/d', 400],
  ]);
  assert.throws(
    () => pool2.run({ op: 'reserve', path: 'root/a/b/c/d', amount: 150, holdId: 'h-x2' }),
    (err) => err.code === 'E_CAPACITY' && err.message.includes('at root/a/b:')
  );

  // Multiple failing nodes: deepest one is reported (c=300, d=400 both < 450, b=100 < 450).
  assert.throws(
    () => pool2.run({ op: 'reserve', path: 'root/a/b/c/d', amount: 450, holdId: 'h-x3' }),
    (err) => err.code === 'E_CAPACITY' && err.message.includes('at root/a/b/c/d:')
  );

  // Failed reserves freeze nothing.
  assert.equal(pool2.subtreeExposure('root').exposure, 0);
});

test('B: batch third op fails, first two holds roll back hierarchically', () => {
  const pool = buildChain([
    ['root', 100],
    ['root/east', 80],
    ['root/west', 80],
  ]);
  const before = pool.subtreeExposure('root');
  assert.throws(
    () =>
      pool.run({
        op: 'batch',
        ops: [
          { op: 'reserve', path: 'root/east', amount: 30, holdId: 'h1' },
          { op: 'reserve', path: 'root/west', amount: 30, holdId: 'h2' },
          { op: 'reserve', path: 'root/east', amount: 60, holdId: 'h3' }, // east: 30+60>80 -> fail
        ],
      }),
    (err) => err.code === 'E_CAPACITY'
  );
  // Everything back to pre-call state.
  assert.deepEqual(pool.subtreeExposure('root'), before);
  assert.equal(pool.holds.size, 0);
  assert.equal(pool.root.held, 0);
  assert.equal(pool.root.children.get('east').held, 0);
  assert.equal(pool.root.children.get('west').held, 0);

  // Nested batch rollback: inner batch commits, outer fails afterwards.
  pool.run({ op: 'reserve', path: 'root/east', amount: 10, holdId: 'keep' });
  const snap = pool.subtreeExposure('root');
  assert.throws(() =>
    pool.run({
      op: 'batch',
      ops: [
        { op: 'batch', ops: [
          { op: 'reserve', path: 'root/west', amount: 20, holdId: 'n1' },
          { op: 'commit', holdId: 'keep' },
        ] },
        { op: 'reserve', path: 'root/east', amount: 999, holdId: 'n2' },
      ],
    })
  );
  assert.deepEqual(pool.subtreeExposure('root'), snap);
  assert.equal(pool.holds.get('keep').state, 'active');
  assert.equal(pool.holds.has('n1'), false);
});

// Recursive reference implementation: no incremental state, full traversal per query.
class RefPool {
  constructor() { this.nodes = new Map(); this.holds = new Map(); }
  add(p, limit) { this.nodes.set(p, { limit, held: 0, spent: 0 }); }
  ancestors(p) {
    const segs = p.split('/');
    const out = [];
    for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join('/'));
    return out.filter((x) => this.nodes.has(x));
  }
  reserve(p, amount, id) {
    for (const a of this.ancestors(p)) {
      const n = this.nodes.get(a);
      if (n.limit - n.held - n.spent < amount) {
        const err = new Error('cap'); err.code = 'E_CAPACITY'; throw err;
      }
    }
    if (this.holds.has(id)) { const err = new Error('dup'); err.code = 'E_DUPLICATE_HOLD'; throw err; }
    for (const a of this.ancestors(p)) this.nodes.get(a).held += amount;
    this.holds.set(id, { path: p, amount, state: 'active' });
  }
  commit(id) {
    const h = this.holds.get(id);
    if (!h) { const err = new Error('orphan'); err.code = 'E_ORPHAN_HOLD'; throw err; }
    if (h.state === 'committed') return;
    if (h.state === 'aborted') { const err = new Error('state'); err.code = 'E_HOLD_STATE'; throw err; }
    for (const a of this.ancestors(h.path)) { const n = this.nodes.get(a); n.held -= h.amount; n.spent += h.amount; }
    h.state = 'committed';
  }
  abort(id) {
    const h = this.holds.get(id);
    if (!h) { const err = new Error('orphan'); err.code = 'E_ORPHAN_HOLD'; throw err; }
    if (h.state === 'aborted') return;
    if (h.state === 'committed') { const err = new Error('state'); err.code = 'E_HOLD_STATE'; throw err; }
    for (const a of this.ancestors(h.path)) this.nodes.get(a).held -= h.amount;
    h.state = 'aborted';
  }
  exposure(p) {
    // Full recursive traversal every call.
    let held = 0, spent = 0;
    for (const [key, n] of this.nodes) {
      if (key === p || key.startsWith(p + '/')) { held += n.held; spent += n.spent; }
    }
    return { held, spent, exposure: held + spent };
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('C: 300 random ops match recursive reference implementation', () => {
  const rand = mulberry32(20261002);
  const pool = new Pool();
  const ref = new RefPool();
  const paths = ['root'];

  pool.run({ op: 'add', path: 'root', limit: 500 });
  ref.add('root', 500);

  let holdSeq = 0;
  const activeHolds = [];

  for (let step = 0; step < 300; step++) {
    const kind = rand();
    if (kind < 0.15 && paths.length < 40) {
      // add node
      const parent = paths[Math.floor(rand() * paths.length)];
      const name = `n${paths.length}`;
      const p = `${parent}/${name}`;
      const limit = 20 + Math.floor(rand() * 200);
      pool.run({ op: 'add', path: p, limit });
      ref.add(p, limit);
      paths.push(p);
    } else if (kind < 0.55) {
      // reserve (sometimes over capacity)
      const p = paths[Math.floor(rand() * paths.length)];
      const amount = 1 + Math.floor(rand() * 120);
      const id = `h${holdSeq++}`;
      let poolErr = null, refErr = null;
      try { pool.run({ op: 'reserve', path: p, amount, holdId: id }); } catch (e) { poolErr = e.code; }
      try { ref.reserve(p, amount, id); } catch (e) { refErr = e.code; }
      assert.equal(poolErr, refErr, `step ${step} reserve ${p} ${amount}`);
      if (!poolErr) activeHolds.push(id);
    } else if (kind < 0.8) {
      // commit: mostly active holds, sometimes unknown (orphan)
      const id = activeHolds.length && rand() < 0.85
        ? activeHolds.splice(Math.floor(rand() * activeHolds.length), 1)[0]
        : `ghost-${step}`;
      let poolErr = null, refErr = null;
      try { pool.run({ op: 'commit', holdId: id }); } catch (e) { poolErr = e.code; }
      try { ref.commit(id); } catch (e) { refErr = e.code; }
      assert.equal(poolErr, refErr, `step ${step} commit ${id}`);
    } else {
      // abort
      const id = activeHolds.length && rand() < 0.85
        ? activeHolds.splice(Math.floor(rand() * activeHolds.length), 1)[0]
        : `ghost-${step}`;
      let poolErr = null, refErr = null;
      try { pool.run({ op: 'abort', holdId: id }); } catch (e) { poolErr = e.code; }
      try { ref.abort(id); } catch (e) { refErr = e.code; }
      assert.equal(poolErr, refErr, `step ${step} abort ${id}`);
    }

    // Incremental aggregates must equal recursive reference on a random subtree.
    const probe = paths[Math.floor(rand() * paths.length)];
    assert.deepEqual(pool.subtreeExposure(probe), { path: probe, ...ref.exposure(probe) }, `step ${step} exposure ${probe}`);
  }

  // Final full-tree comparison of every node.
  for (const p of paths) {
    assert.deepEqual(pool.subtreeExposure(p), { path: p, ...ref.exposure(p) }, `final ${p}`);
  }
});

test('D: repeated commit/abort are idempotent no-ops; cross-transition rejected', () => {
  const pool = buildChain([['root', 100], ['root/a', 60]]);
  pool.run({ op: 'reserve', path: 'root/a', amount: 20, holdId: 'h1' });

  const first = pool.run({ op: 'commit', holdId: 'h1' });
  assert.equal(first.committed, 20);
  const again = pool.run({ op: 'commit', holdId: 'h1' });
  assert.deepEqual(again, { holdId: 'h1', idempotent: true });
  assert.equal(pool.subtreeExposure('root').spent, 40); // 20 on root + 20 on a, not doubled

  assert.throws(() => pool.run({ op: 'abort', holdId: 'h1' }), (e) => e.code === 'E_HOLD_STATE');

  pool.run({ op: 'reserve', path: 'root/a', amount: 10, holdId: 'h2' });
  pool.run({ op: 'abort', holdId: 'h2' });
  assert.deepEqual(pool.run({ op: 'abort', holdId: 'h2' }), { holdId: 'h2', idempotent: true });
  assert.equal(pool.subtreeExposure('root').held, 0);
  assert.throws(() => pool.run({ op: 'commit', holdId: 'h2' }), (e) => e.code === 'E_HOLD_STATE');

  assert.throws(() => pool.run({ op: 'commit', holdId: 'never' }), (e) => e.code === 'E_ORPHAN_HOLD');
  assert.throws(() => pool.run({ op: 'abort', holdId: 'never' }), (e) => e.code === 'E_ORPHAN_HOLD');
});

test('CLI: exec ops.jsonl --stats, and E_CAPACITY on stderr with non-zero exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const makeIo = () => {
    const out = [], err = [];
    return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
  };

  const okFile = path.join(dir, 'ok.jsonl');
  fs.writeFileSync(okFile, [
    '{"op":"add","path":"root","limit":100}',
    '{"op":"reserve","path":"root","amount":40,"holdId":"h1"}',
    '{"op":"abort","holdId":"h1"}',
  ].join('\n'));
  const ok = makeIo();
  const okCode = runCli(['exec', okFile, '--stats'], ok.io);
  assert.equal(okCode, 0);
  assert.equal(ok.err.length, 0);
  const lines = ok.out.map(JSON.parse);
  const stats = lines.find((l) => l.stats).stats;
  assert.equal(stats.processed, 3);
  assert.equal(stats.activeHolds, 0);
  assert.equal(stats.root.exposure, 0);

  const badFile = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(badFile, [
    '{"op":"add","path":"root","limit":10}',
    '{"op":"reserve","path":"root","amount":50,"holdId":"h1"}',
  ].join('\n'));
  const bad = makeIo();
  const badCode = runCli(['exec', badFile], bad.io);
  assert.notEqual(badCode, 0);
  const errObj = JSON.parse(bad.err[0]);
  assert.equal(errObj.code, 'E_CAPACITY');
  assert.match(errObj.message, /root/);

  const orphanFile = path.join(dir, 'orphan.jsonl');
  fs.writeFileSync(orphanFile, '{"op":"add","path":"root","limit":10}\n{"op":"commit","holdId":"ghost"}');
  const orphan = makeIo();
  const orphanCode = runCli(['exec', orphanFile], orphan.io);
  assert.notEqual(orphanCode, 0);
  assert.equal(JSON.parse(orphan.err[0]).code, 'E_ORPHAN_HOLD');
});
