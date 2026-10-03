'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { Store, StoreError, frameCrc, frameHash } = require('../lib');

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obslog-')), 'log');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent in-memory reference model mirroring the spec semantics.
class Model {
  constructor() {
    this.byId = new Map();
    this.seq = 0;
  }
  _list(id) {
    let l = this.byId.get(id);
    if (!l) { l = []; this.byId.set(id, l); }
    return l;
  }
  _latest(id) {
    const l = this.byId.get(id);
    if (!l || !l.length) return null;
    let best = l[0];
    for (const f of l) if (f.ts > best.ts || (f.ts === best.ts && f.seq > best.seq)) best = f;
    return best;
  }
  appendObs(id, ts, value) {
    this._list(id).push({ seq: this.seq++, type: 'OBS', id, ts, value, quality: 'OK' });
  }
  flag(id, quality) {
    const latest = this._latest(id);
    this._list(id).push({ seq: this.seq++, type: 'FLAG', id, ts: latest.ts, value: null, quality });
  }
  invalidate(id) {
    const latest = this._latest(id);
    this._list(id).push({ seq: this.seq++, type: 'TOMB', id, ts: latest.ts, value: null, quality: null });
  }
  current(id) {
    const latest = this._latest(id);
    if (!latest || latest.type === 'TOMB') return null;
    const sorted = this.byId.get(id)
      .filter((f) => f.ts < latest.ts || (f.ts === latest.ts && f.seq <= latest.seq))
      .sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
    let state = null;
    for (const f of sorted) {
      if (f.type === 'OBS') state = { id: f.id, ts: f.ts, value: f.value, quality: f.quality };
      else if (f.type === 'FLAG' && state) state.quality = f.quality;
    }
    return state;
  }
  history(id) {
    const l = this.byId.get(id);
    if (!l || !l.length) return null;
    return l.slice().sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  }
}

function expectCode(code, fn) {
  assert.throws(fn, (e) => e instanceof StoreError && e.code === code);
}

function compareAll(store, model, ids) {
  for (const id of ids) {
    let cur = null;
    try { cur = store.current(id); } catch (e) { assert.equal(e.code, 'ERR_NOTFOUND'); }
    const exp = model.current(id);
    if (exp === null) assert.equal(cur, null, `current(${id}) should be NOTFOUND`);
    else {
      assert.ok(cur, `current(${id}) should exist`);
      assert.equal(cur.id, exp.id);
      assert.equal(cur.ts, exp.ts);
      assert.deepEqual(cur.value, exp.value);
      assert.equal(cur.quality, exp.quality);
    }
    let his = null;
    try { his = store.history(id); } catch (e) { assert.equal(e.code, 'ERR_NOTFOUND'); }
    const expHis = model.history(id);
    if (expHis === null) assert.equal(his, null, `history(${id}) should be NOTFOUND`);
    else {
      assert.deepEqual(
        his.map((f) => [f.seq, f.type, f.id, f.ts, f.value, f.quality]),
        expHis.map((f) => [f.seq, f.type, f.id, f.ts, f.value, f.quality]),
        `history(${id}) mismatch`,
      );
    }
  }
}

test('1. random op sequence matches in-memory reference model', () => {
  const log = tmpLog();
  const store = new Store(log);
  const model = new Model();
  const rnd = mulberry32(20261003);
  const ids = ['a', 'b', 'c', 'obs7'];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (let step = 0; step < 600; step++) {
    const id = pick(ids);
    const roll = rnd();
    if (roll < 0.45) {
      const ts = Math.floor(rnd() * 6); // small ts pool forces same-id same-ts collisions
      const value = Math.floor(rnd() * 1000);
      store.appendObs(id, ts, value);
      model.appendObs(id, ts, value);
    } else if (roll < 0.65) {
      // flag with the valid ref when possible
      let cur = null;
      try { cur = store.current(id); } catch { /* NOTFOUND */ }
      if (cur) {
        store.flag(id, cur.hash, 'SUSPECT');
        model.flag(id, 'SUSPECT');
      } else if (model._latest(id)) {
        expectCode('ERR_STALE', () => store.flag(id, 'deadbeef', 'SUSPECT')); // tombed
      } else {
        expectCode('ERR_NOTFOUND', () => store.flag(id, 'deadbeef', 'SUSPECT'));
      }
    } else if (roll < 0.75) {
      // flag with a stale ref (older frame of the same id)
      let his = null;
      try { his = store.history(id); } catch { /* NOTFOUND */ }
      let cur = null;
      try { cur = store.current(id); } catch { /* NOTFOUND */ }
      if (his && cur && his.length >= 2) {
        const older = his.find((f) => f.hash !== cur.hash);
        if (older) expectCode('ERR_STALE', () => store.flag(id, older.hash, 'REVIEWED'));
      }
    } else if (roll < 0.9) {
      if (model._latest(id)) {
        store.invalidate(id);
        model.invalidate(id);
      } else {
        expectCode('ERR_NOTFOUND', () => store.invalidate(id));
      }
    } else {
      assert.deepEqual(store.verify().ok, true);
    }
    compareAll(store, model, ids);
    if (step % 200 === 199) {
      // index loss: rebuild by scanning the log, results must be identical
      const fresh = new Store(log);
      compareAll(fresh, model, ids);
      assert.deepEqual(fresh.verify().ok, true);
    }
  }
});

test('2. tampering with an old OBS value is detected by the hash chain', () => {
  const log = tmpLog();
  const store = new Store(log);
  store.appendObs('obs7', 100, 42);
  store.appendObs('obs7', 101, 43);
  store.appendObs('obs8', 100, 7);
  assert.deepEqual(store.verify().ok, true);

  const tamper = (fixSelf) => {
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const frame = JSON.parse(lines[0]);
    frame.value = 9999; // alter old OBS value
    if (fixSelf) { // attacker recomputes crc + own hash to look self-consistent
      frame.crc = frameCrc(frame);
      frame.hash = frameHash(frame);
    }
    lines[0] = JSON.stringify(frame);
    fs.writeFileSync(log, lines.join('\n') + '\n');
  };

  tamper(true);
  expectCode('ERR_CHAIN', () => store.verify());
});

test('2b. tampering without fixing crc is detected as ERR_CRC', () => {
  const log = tmpLog();
  const store = new Store(log);
  store.appendObs('obs7', 100, 42);
  store.appendObs('obs7', 101, 43);
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const frame = JSON.parse(lines[0]);
  frame.value = 9999;
  lines[0] = JSON.stringify(frame);
  fs.writeFileSync(log, lines.join('\n') + '\n');
  expectCode('ERR_CRC', () => store.verify());
});

test('3. two frames with same id and same ts order deterministically by seq', () => {
  const log = tmpLog();
  const store = new Store(log);
  store.appendObs('x', 100, 'first');
  store.appendObs('x', 100, 'second');
  store.appendObs('y', 100, 'other');
  assert.equal(store.current('x').value, 'second'); // higher frame seq wins
  const rebuilt = new Store(log); // rescan from disk
  assert.equal(rebuilt.current('x').value, 'second');
  const his = rebuilt.history('x');
  assert.deepEqual(his.map((f) => f.value), ['first', 'second']);
  assert.ok(his[0].seq < his[1].seq);
});

test('4. flag after invalidate reports ERR_STALE', () => {
  const log = tmpLog();
  const store = new Store(log);
  const f = store.appendObs('obs7', 100, 42);
  store.invalidate('obs7');
  expectCode('ERR_STALE', () => store.flag('obs7', f.hash, 'REVIEWED'));
  expectCode('ERR_NOTFOUND', () => store.current('obs7')); // current ignores TOMB
  const types = store.history('obs7').map((h) => h.type); // history keeps TOMB
  assert.deepEqual(types, ['OBS', 'TOMB']);
});

test('5. querying an empty or unknown id reports ERR_NOTFOUND', () => {
  const log = tmpLog();
  const store = new Store(log);
  store.appendObs('obs7', 100, 42);
  expectCode('ERR_NOTFOUND', () => store.current(''));
  expectCode('ERR_NOTFOUND', () => store.history(''));
  expectCode('ERR_NOTFOUND', () => store.current('nope'));
  expectCode('ERR_NOTFOUND', () => store.history('nope'));
  expectCode('ERR_NOTFOUND', () => store.invalidate('nope'));
});

test('cli: append/current/history/verify and JSON errors on stderr', () => {
  const log = tmpLog();
  const dir = path.dirname(log);
  let n = 0;
  // Sandboxed environments may break child stdio pipes; capture via files.
  const cli = (args) => {
    const outFile = path.join(dir, `out-${n}.txt`);
    const errFile = path.join(dir, `err-${n}.txt`);
    n++;
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return {
      status: r.status,
      stdout: fs.readFileSync(outFile, 'utf8'),
      stderr: fs.readFileSync(errFile, 'utf8'),
    };
  };

  let r = cli(['append', log, 'obs7', '100', '42']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['current', log, 'obs7']);
  assert.equal(r.status, 0, r.stderr);
  const cur = JSON.parse(r.stdout);
  assert.equal(cur.value, 42);
  assert.equal(cur.quality, 'OK');

  r = cli(['flag', log, 'obs7', cur.hash, 'SUSPECT']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['current', log, 'obs7']);
  assert.equal(JSON.parse(r.stdout).quality, 'SUSPECT');

  r = cli(['history', log, 'obs7']);
  assert.equal(JSON.parse(r.stdout).length, 2);

  r = cli(['verify', log]);
  assert.deepEqual(JSON.parse(r.stdout).ok, true);

  r = cli(['current', log, 'nope']);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: 'ERR_NOTFOUND' });
  assert.equal(r.stdout, '');

  r = cli(['invalidate', log, 'obs7']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['flag', log, 'obs7', cur.hash, 'OK']);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: 'ERR_STALE' });
});
