'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Log, LogError } = require('../lib');
const { run } = require('../cli');

function cli(...args) {
  let stdout = '';
  let stderr = '';
  let code;
  try {
    code = run(
      ['node', 'cli.js', ...args],
      { write: (s) => { stdout += s; } },
      { write: (s) => { stderr += s; } }
    );
  } catch (e) {
    stderr += JSON.stringify({ error: e.code || 'ERR_INTERNAL' }) + '\n';
    code = 1;
  }
  return { code, stdout, stderr };
}

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obslog-'));
  return path.join(dir, 'log.ndjson');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// In-memory reference model mirroring the Log semantics.
class Model {
  constructor() {
    this.byId = new Map();
    this.seq = 0;
  }

  _list(id) {
    let e = this.byId.get(id);
    if (!e) {
      e = [];
      this.byId.set(id, e);
    }
    return e;
  }

  _latest(id) {
    const e = this.byId.get(id);
    if (!e || e.length === 0) return null;
    return e[e.length - 1];
  }

  _push(id, frame) {
    const e = this._list(id);
    e.push({ seq: this.seq++, ...frame });
    e.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }

  obs(id, ts, value) {
    this._push(id, { type: 'OBS', ts, value, quality: 'ok' });
  }

  flag(id, quality, ts) {
    const latest = this._latest(id);
    if (!latest) throw new LogError('ERR_NOTFOUND');
    if (latest.type === 'TOMB') throw new LogError('ERR_STALE');
    this._push(id, { type: 'FLAG', ts, value: null, quality });
  }

  invalidate(id, ts) {
    const latest = this._latest(id);
    if (!latest) throw new LogError('ERR_NOTFOUND');
    if (latest.type === 'TOMB') throw new LogError('ERR_STALE');
    this._push(id, { type: 'TOMB', ts, value: null, quality: null });
  }

  current(id) {
    const e = this.byId.get(id);
    if (!e) throw new LogError('ERR_NOTFOUND');
    let state = null;
    for (const f of e) {
      if (f.type === 'OBS') state = { id, value: f.value, quality: f.quality, ts: f.ts };
      else if (f.type === 'FLAG') { if (state) state.quality = f.quality; }
      else if (f.type === 'TOMB') state = null;
    }
    if (!state) throw new LogError('ERR_NOTFOUND');
    return state;
  }

  history(id) {
    const e = this.byId.get(id);
    if (!e) throw new LogError('ERR_NOTFOUND');
    return e.map((f) => ({ seq: f.seq, type: f.type, ts: f.ts, value: f.value, quality: f.quality }));
  }
}

function currentOf(log, id) {
  try {
    return { ok: true, value: log.current(id) };
  } catch (e) {
    return { ok: false, code: e.code };
  }
}

function historyOf(log, id) {
  try {
    return {
      ok: true,
      value: log.history(id).map((f) => ({
        seq: f.seq, type: f.type, ts: f.ts, value: f.value, quality: f.quality,
      })),
    };
  } catch (e) {
    return { ok: false, code: e.code };
  }
}

test('random op sequence matches in-memory reference model', () => {
  const rand = mulberry32(12345);
  const logPath = tmpLog();
  const log = new Log(logPath);
  const model = new Model();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  for (let step = 0; step < 600; step++) {
    const id = pick(ids);
    const ts = Math.floor(rand() * 60);
    const op = rand();
    if (op < 0.5) {
      const value = Math.floor(rand() * 1000);
      log.appendObs(id, ts, value);
      model.obs(id, ts, value);
    } else if (op < 0.75) {
      const quality = pick(['suspect', 'reviewed', 'good']);
      let logErr = null;
      let modelErr = null;
      try { log.flag(id, quality, ts); } catch (e) { logErr = e.code; }
      try { model.flag(id, quality, ts); } catch (e) { modelErr = e.code; }
      assert.equal(logErr, modelErr, `flag error mismatch at step ${step}`);
    } else if (op < 0.9) {
      let logErr = null;
      let modelErr = null;
      try { log.invalidate(id, ts); } catch (e) { logErr = e.code; }
      try { model.invalidate(id, ts); } catch (e) { modelErr = e.code; }
      assert.equal(logErr, modelErr, `invalidate error mismatch at step ${step}`);
    } else {
      assert.deepEqual(currentOf(log, id), currentOf(model, id), `current mismatch at step ${step}`);
      assert.deepEqual(historyOf(log, id), historyOf(model, id), `history mismatch at step ${step}`);
    }
  }

  // Rebuild index from disk by scanning and compare everything again.
  const rebuilt = new Log(logPath);
  assert.deepEqual(rebuilt.verify(), { ok: true, frames: log.frames.length });
  for (const id of ids) {
    assert.deepEqual(currentOf(rebuilt, id), currentOf(model, id), `rebuilt current mismatch for ${id}`);
    assert.deepEqual(historyOf(rebuilt, id), historyOf(model, id), `rebuilt history mismatch for ${id}`);
  }
});

test('tampering with an old OBS value is detected by the chain', () => {
  const logPath = tmpLog();
  const log = new Log(logPath);
  log.appendObs('s1', 1, 100);
  log.appendObs('s1', 2, 101);
  log.flag('s1', 'suspect', 3);
  log.appendObs('s1', 4, 102);
  assert.deepEqual(log.verify(), { ok: true, frames: 4 });

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const tampered = JSON.parse(lines[1]);
  tampered.value = 999;
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');

  assert.throws(() => new Log(logPath), (e) => e.code === 'ERR_CRC' || e.code === 'ERR_CHAIN');
});

test('two frames with same id and ts order deterministically by seq', () => {
  const logPath = tmpLog();
  const log = new Log(logPath);
  log.appendObs('x', 100, 'first');
  log.appendObs('x', 100, 'second');
  assert.equal(log.current('x').value, 'second');

  // Deterministic after index rebuild from disk.
  const rebuilt = new Log(logPath);
  assert.equal(rebuilt.current('x').value, 'second');
  const hist = rebuilt.history('x');
  assert.deepEqual(hist.map((h) => h.value), ['first', 'second']);
  assert.deepEqual(hist.map((h) => h.seq), [0, 1]);
});

test('flag after invalidate fails with ERR_STALE', () => {
  const logPath = tmpLog();
  const log = new Log(logPath);
  log.appendObs('obs7', 10, 42);
  log.invalidate('obs7', 11);
  assert.throws(() => log.flag('obs7', 'reviewed', 12), (e) => e.code === 'ERR_STALE');
  // current ignores the TOMB-ed observation, history keeps it.
  assert.throws(() => log.current('obs7'), (e) => e.code === 'ERR_NOTFOUND');
  assert.deepEqual(log.history('obs7').map((f) => f.type), ['OBS', 'TOMB']);
});

test('querying an unknown id fails with ERR_NOTFOUND', () => {
  const logPath = tmpLog();
  const log = new Log(logPath);
  assert.throws(() => log.current('nope'), (e) => e.code === 'ERR_NOTFOUND');
  assert.throws(() => log.history('nope'), (e) => e.code === 'ERR_NOTFOUND');
});

test('cli: append/current/history/verify and JSON errors on stderr', () => {
  const logPath = tmpLog();
  assert.equal(cli('append', logPath, 'obs7', '10', '42').code, 0);
  assert.equal(cli('flag', logPath, 'obs7', 'reviewed', '11').code, 0);

  const cur = cli('current', logPath, 'obs7');
  assert.equal(cur.code, 0);
  assert.deepEqual(JSON.parse(cur.stdout), { id: 'obs7', value: 42, quality: 'reviewed', ts: 10 });

  const hist = JSON.parse(cli('history', logPath, 'obs7').stdout);
  assert.deepEqual(hist.map((h) => h.type), ['OBS', 'FLAG']);

  const ver = JSON.parse(cli('verify', logPath).stdout);
  assert.deepEqual(ver, { ok: true, frames: 2 });

  const missing = cli('current', logPath, 'ghost');
  assert.equal(missing.code, 1);
  assert.deepEqual(JSON.parse(missing.stderr), { error: 'ERR_NOTFOUND' });

  assert.equal(cli('invalidate', logPath, 'obs7', '12').code, 0);
  const stale = cli('flag', logPath, 'obs7', 'good', '13');
  assert.equal(stale.code, 1);
  assert.deepEqual(JSON.parse(stale.stderr), { error: 'ERR_STALE' });
});
