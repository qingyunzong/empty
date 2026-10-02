'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hist = require('../lib/history');
const { crc32 } = require('../lib/crc32');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
}

function silent() {
  const reports = [];
  return { reports, onReport: (r) => reports.push(r) };
}

function crcHex(text) {
  return crc32(Buffer.from(text, 'utf8')).toString(16).padStart(8, '0');
}

function rawRecord(rec) {
  const body = { ...rec };
  body.crc = crcHex(hist.canonical(body));
  return body;
}

function writeLog(dir, records) {
  fs.writeFileSync(path.join(dir, 'events.log'), records.map(hist.encodeBlock).join(''));
}

function buildDiamond(dir) {
  hist.init(dir);
  const r = hist.append(dir, { author: 'A', payload: { seq: [1] } }).id;
  const a = hist.append(dir, { author: 'A', payload: { seq: [1, 2] }, parents: [r] }).id;
  const b = hist.append(dir, { author: 'B', payload: { seq: [1, 3] }, parents: [r] }).id;
  return { r, a, b };
}

test('1. isAncestor matches enumeration of all topological orders', () => {
  const dir = tmpdir();
  hist.init(dir);
  const r = hist.append(dir, { author: 'A', payload: 'r' }).id;
  const a = hist.append(dir, { author: 'A', payload: 'a', parents: [r] }).id;
  const b = hist.append(dir, { author: 'B', payload: 'b', parents: [r] }).id;
  const c = hist.append(dir, { author: 'A', payload: 'c', parents: [a] }).id;
  const d = hist.append(dir, { author: 'B', payload: 'd', parents: [a, b] }).id;

  const { onReport } = silent();
  const store = hist.loadStore(dir, onReport);
  const ids = [r, a, b, c, d];
  const parentsOf = new Map(ids.map((id) => [id, store.events.get(id).parents]));

  const orders = [];
  const indeg = new Map(ids.map((id) => [id, parentsOf.get(id).length]));
  const children = new Map(ids.map((id) => [id, []]));
  for (const id of ids) for (const p of parentsOf.get(id)) children.get(p).push(id);
  (function walk(prefix) {
    if (prefix.length === ids.length) { orders.push(prefix); return; }
    for (const id of ids) {
      if (indeg.get(id) === 0 && !prefix.includes(id)) {
        indeg.set(id, -1);
        for (const ch of children.get(id)) indeg.set(ch, indeg.get(ch) - 1);
        walk([...prefix, id]);
        for (const ch of children.get(id)) indeg.set(ch, indeg.get(ch) + 1);
        indeg.set(id, 0);
      }
    }
  })([]);
  assert.ok(orders.length > 1, 'expected multiple topological orders');

  for (const x of ids) {
    for (const y of ids) {
      if (x === y) continue;
      const expected = orders.every((ord) => ord.indexOf(x) < ord.indexOf(y));
      assert.equal(hist.isAncestor(dir, x, y, onReport), expected, `isAncestor(${x}, ${y})`);
    }
  }
  assert.equal(hist.isAncestor(dir, r, r, onReport), false, 'strict: not own ancestor');
});

test('2. diamond concurrency merges deterministically regardless of order', () => {
  const dir = tmpdir();
  const { r, a, b } = buildDiamond(dir);
  const { onReport } = silent();

  assert.equal(hist.isAncestor(dir, a, b, onReport), false);
  assert.equal(hist.isAncestor(dir, b, a, onReport), false);
  assert.deepEqual(hist.heads(dir, onReport).heads, [a, b].sort());

  const m1 = hist.merge(dir, a, b, {}, onReport);
  assert.equal(m1.created, true);
  const m2 = hist.merge(dir, b, a, {}, onReport);
  assert.equal(m1.head, m2.head, 'merge(a,b) === merge(b,a)');
  assert.deepEqual(hist.heads(dir, onReport).heads, [m1.head]);
  assert.equal(hist.isAncestor(dir, r, m1.head, onReport), true);
  assert.equal(hist.isAncestor(dir, a, m1.head, onReport), true);

  const again = hist.merge(dir, a, b, {}, onReport);
  assert.equal(again.head, m1.head);
  assert.equal(again.created, false, 'idempotent: no duplicate merge block');

  const seq = hist.checkout(dir, m1.head, onReport);
  assert.equal(seq.length, 4);
  assert.equal(seq[0].id, r);
  assert.equal(seq.at(-1).id, m1.head);

  assert.equal(hist.merge(dir, m1.head, b, {}, onReport).head, m1.head, 'ancestor merge is a no-op');
});

test('2b. CLI: node cli.js merge h1 h2 is deterministic', () => {
  const dir = tmpdir();
  const { a, b } = buildDiamond(dir);
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  const runCli = (args) => {
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const res = spawnSync(process.execPath, [CLI, '--dir', dir, ...args], { stdio: ['ignore', outFd, errFd] });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return {
      status: res.status,
      stdout: fs.readFileSync(outFile, 'utf8').trim(),
      stderr: fs.readFileSync(errFile, 'utf8').trim(),
    };
  };
  const run = (args) => {
    const res = runCli(args);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const m1 = run(['merge', a, b]);
  const m2 = run(['merge', b, a]);
  assert.equal(m1.head, m2.head);
  assert.deepEqual(run(['heads']).heads, [m1.head]);
  const bad = runCli(['merge', a, 'eMissing']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr.split('\n').at(-1)).error, 'ERR_HEAD');
});

test('3. cyclic and missing-parent histories are rejected', () => {
  const dir = tmpdir();
  hist.init(dir);
  const e1 = rawRecord({ id: 'eFake1', kind: 'event', parents: ['eFake2'], author: 'X', counter: 1, payload: null });
  const e2 = rawRecord({ id: 'eFake2', kind: 'event', parents: ['eFake1'], author: 'X', counter: 2, payload: null });
  writeLog(dir, [e1, e2]);
  assert.throws(() => hist.heads(dir, () => {}), (err) => err.code === 'ERR_CYCLE');

  const dir2 = tmpdir();
  hist.init(dir2);
  const e3 = rawRecord({ id: 'eFake3', kind: 'event', parents: ['eGone'], author: 'X', counter: 1, payload: null });
  writeLog(dir2, [e3]);
  assert.throws(() => hist.heads(dir2, () => {}), (err) => err.code === 'ERR_MISSING_PARENT');

  const dir3 = tmpdir();
  hist.init(dir3);
  assert.throws(
    () => hist.append(dir3, { author: 'A', payload: null, parents: ['eNope'] }, () => {}),
    (err) => err.code === 'ERR_MISSING_PARENT',
  );
});

test('4. undo rejects non-leaf with ERR_CONFLICT and keeps a tombstone', () => {
  const dir = tmpdir();
  hist.init(dir);
  const { onReport } = silent();
  const r = hist.append(dir, { author: 'A', payload: 'r' }).id;
  const a = hist.append(dir, { author: 'A', payload: 'a' }).id;

  assert.throws(() => hist.undo(dir, r, {}, onReport), (err) => err.code === 'ERR_CONFLICT');
  assert.throws(() => hist.undo(dir, 'eMissing', {}, onReport), (err) => err.code === 'ERR_HEAD');

  const res = hist.undo(dir, a, {}, onReport);
  assert.equal(res.undone, a);
  assert.deepEqual(hist.heads(dir, onReport).heads, [r]);

  const log = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
  assert.ok(log.includes('"kind":"tombstone"'), 'tombstone block persisted');
  assert.ok(log.includes(res.tombstone));

  assert.throws(() => hist.undo(dir, a, {}, onReport), (err) => err.code === 'ERR_HEAD');
});

test('5. corrupted heads/index files are rebuilt from the event graph with a report', () => {
  const dir = tmpdir();
  const { a, b } = buildDiamond(dir);
  const m = hist.merge(dir, a, b, {}, () => {});

  fs.writeFileSync(path.join(dir, 'heads.json'), JSON.stringify({ heads: ['eBogus'] }));
  fs.writeFileSync(path.join(dir, 'index.json'), 'not json at all');

  const { reports, onReport } = silent();
  const res = hist.heads(dir, onReport);
  assert.equal(res.rebuilt, true);
  assert.deepEqual(res.heads, [m.head]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].rebuilt, true);
  assert.deepEqual(reports[0].computedHeads, [m.head]);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'heads.json'), 'utf8'));
  assert.deepEqual(onDisk.heads, [m.head]);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.order.length, 4);

  const again = hist.heads(dir, onReport);
  assert.equal(again.rebuilt, false, 'stable after rebuild');
});

test('6. identical payloads under different ids are never auto-merged', () => {
  const dir = tmpdir();
  hist.init(dir);
  const { onReport } = silent();
  const r = hist.append(dir, { author: 'A', payload: { fix: 1 } }).id;
  const x = hist.append(dir, { author: 'A', payload: { fix: 2 }, parents: [r] }).id;
  const y = hist.append(dir, { author: 'B', payload: { fix: 2 }, parents: [r] }).id;
  assert.notEqual(x, y);
  assert.deepEqual(hist.heads(dir, onReport).heads, [x, y].sort(), 'both corrections survive as concurrent heads');
});
