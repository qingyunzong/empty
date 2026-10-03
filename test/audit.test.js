'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditLog, AuditError } = require('../src/audit');
const { run: runCli } = require('../cli');

// Acceptance 1: after a revoke, asOf before/after the revoke differ.
test('revoke changes the as-of view before vs after', () => {
  const log = new AuditLog();
  log.apply({ op: 'append', id: 'a', ts: 1, data: { note: 'ok' } });
  log.apply({ op: 'revoke', id: 'r', ts: 2, targetId: 'a' });

  const before = log.viewAt(1);
  const after = log.viewAt(2);

  assert.deepEqual(before.visible.map((e) => e.id), ['a']);
  assert.deepEqual(before.hidden, [{ id: 'r', reason: 'after_as_of' }]);
  assert.deepEqual(after.visible.map((e) => e.id), ['r']);
  assert.deepEqual(after.hidden, [{ id: 'a', reason: 'revoked_by:r' }]);
  assert.notEqual(before.hash, after.hash);
});

// Acceptance 2: revoking a revoke restores the original entry.
test('revoking a revoke restores visibility (cascade)', () => {
  const log = new AuditLog();
  log.apply({ op: 'append', id: 'a', ts: 1, data: 1 });
  log.apply({ op: 'revoke', id: 'r1', ts: 2, targetId: 'a' });
  log.apply({ op: 'revoke', id: 'r2', ts: 3, targetId: 'r1' });

  const v2 = log.viewAt(2);
  assert.deepEqual(v2.visible.map((e) => e.id), ['r1']);
  assert.deepEqual(v2.hidden, [
    { id: 'a', reason: 'revoked_by:r1' },
    { id: 'r2', reason: 'after_as_of' },
  ]);

  const v3 = log.viewAt(3);
  assert.deepEqual(v3.visible.map((e) => e.id), ['a', 'r2']);
  assert.deepEqual(v3.hidden, [{ id: 'r1', reason: 'revoked_by:r2' }]);
  // a is visible again at t=3 (it was hidden at t=2)
  assert.ok(v3.visible.some((e) => e.id === 'a'));
  assert.ok(v2.hidden.some((h) => h.id === 'a'));
  assert.notEqual(v2.hash, v3.hash);

  // triple cascade: revoking r2 re-activates r1, hiding a again
  log.apply({ op: 'revoke', id: 'r3', ts: 4, targetId: 'r2' });
  const v4 = log.viewAt(4);
  assert.deepEqual(v4.visible.map((e) => e.id), ['r1', 'r3']);
  assert.deepEqual(v4.hidden, [
    { id: 'a', reason: 'revoked_by:r1' },
    { id: 'r2', reason: 'revoked_by:r3' },
  ]);
});

// Acceptance 3: revoke cycles are rejected with E_REVOKE_CYCLE.
test('revoke cycles raise E_REVOKE_CYCLE', () => {
  const self = new AuditLog();
  assert.throws(
    () => self.apply({ op: 'revoke', id: 'r1', ts: 1, targetId: 'r1' }),
    (err) => err instanceof AuditError && err.code === 'E_REVOKE_CYCLE'
  );

  const pair = new AuditLog();
  pair.apply({ op: 'revoke', id: 'r1', ts: 1, targetId: 'r2' });
  assert.throws(
    () => pair.apply({ op: 'revoke', id: 'r2', ts: 2, targetId: 'r1' }),
    (err) => err.code === 'E_REVOKE_CYCLE'
  );

  const tri = new AuditLog();
  tri.apply({ op: 'revoke', id: 'x', ts: 1, targetId: 'z' });
  tri.apply({ op: 'revoke', id: 'y', ts: 2, targetId: 'x' });
  assert.throws(
    () => tri.apply({ op: 'revoke', id: 'z', ts: 3, targetId: 'y' }),
    (err) => err.code === 'E_REVOKE_CYCLE'
  );
});

// --- Acceptance 4: exhaustive as-of enumeration vs an independent oracle ---

// Independent canonicalization (re-implemented here on purpose).
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
      .join(',') +
    '}'
  );
}

// Brute-force oracle: enumerate all 2^k hidden/visible assignments for the
// entries present at t and keep the unique consistent one:
//   hidden(e)  <=>  exists revoke r targeting e with r visible.
function oracleView(entries, t) {
  const present = entries.filter((e) => e.ts <= t);
  const k = present.length;
  let solution = null;
  for (let mask = 0; mask < 1 << k; mask++) {
    const hidden = new Set();
    for (let i = 0; i < k; i++) if ((mask >> i) & 1) hidden.add(present[i].id);
    let ok = true;
    for (const e of present) {
      const shouldHide = present.some(
        (r) => r.op === 'revoke' && r.targetId === e.id && !hidden.has(r.id)
      );
      if (hidden.has(e.id) !== shouldHide) {
        ok = false;
        break;
      }
    }
    if (ok) {
      solution = hidden;
      break;
    }
  }
  assert.notEqual(solution, null, 'oracle found no consistent assignment');
  const visible = present.filter((e) => !solution.has(e.id));
  return {
    visibleIds: visible.map((e) => e.id),
    hash: crypto.createHash('sha256').update(canon(visible), 'utf8').digest('hex'),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random op sequences (n<=8): every asOf matches brute-force replay', () => {
  const TRIALS = 300;
  for (let trial = 0; trial < TRIALS; trial++) {
    const rand = mulberry32(trial * 2654435761 + 1);
    const n = 1 + Math.floor(rand() * 8);
    const log = new AuditLog();
    const entries = [];
    for (let i = 0; i < n; i++) {
      const ts = i + 1;
      const doRevoke = entries.length > 0 && rand() < 0.45;
      if (doRevoke) {
        const target = entries[Math.floor(rand() * entries.length)];
        const cmd = { op: 'revoke', id: `r${i}`, ts, targetId: target.id };
        log.apply(cmd);
        entries.push({ id: cmd.id, ts, op: 'revoke', targetId: cmd.targetId });
      } else {
        const cmd = { op: 'append', id: `a${i}`, ts, data: { v: Math.floor(rand() * 100) } };
        log.apply(cmd);
        entries.push({ id: cmd.id, ts, op: 'append', data: cmd.data });
      }
    }
    for (let t = 0; t <= n; t++) {
      const view = log.viewAt(t);
      const oracle = oracleView(entries, t);
      assert.deepEqual(
        view.visible.map((e) => e.id),
        oracle.visibleIds,
        `trial=${trial} t=${t} visible mismatch`
      );
      assert.equal(view.hash, oracle.hash, `trial=${trial} t=${t} hash mismatch`);
      // hidden list accounts for every non-visible entry exactly once
      const accounted = new Set([...view.visible.map((e) => e.id), ...view.hidden.map((h) => h.id)]);
      assert.equal(accounted.size, entries.length);
      for (const h of view.hidden) {
        assert.match(h.reason, /^(after_as_of|revoked_by:.+)$/);
      }
    }
  }
});

// --- CLI (invoked in-process; `node cli.js ...` shares the same run()) ---

function withTempFile(contents, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'log.jsonl');
  fs.writeFileSync(file, contents);
  return fn(file);
}

function captureCli(argv) {
  let stdout = '';
  let stderr = '';
  const code = runCli(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
}

test('CLI: node cli.js log.jsonl --as-of 3 prints view and hash', () => {
  const body = [
    JSON.stringify({ op: 'append', id: 'a1', ts: 1, data: { amount: 100 } }),
    JSON.stringify({ op: 'append', id: 'a2', ts: 2, data: { amount: 200 } }),
    JSON.stringify({ op: 'revoke', id: 'r1', ts: 3, targetId: 'a1' }),
    '',
  ].join('\n');
  withTempFile(body, (file) => {
    const { code, stdout, stderr } = captureCli(['node', 'cli.js', file, '--as-of', '3']);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const view = JSON.parse(stdout);
    assert.equal(view.asOf, 3);
    assert.deepEqual(view.visible.map((e) => e.id), ['a2', 'r1']);
    assert.deepEqual(view.hidden, [{ id: 'a1', reason: 'revoked_by:r1' }]);
    assert.match(view.hash, /^[0-9a-f]{64}$/);

    const log = new AuditLog();
    log.apply({ op: 'append', id: 'a1', ts: 1, data: { amount: 100 } });
    log.apply({ op: 'append', id: 'a2', ts: 2, data: { amount: 200 } });
    log.apply({ op: 'revoke', id: 'r1', ts: 3, targetId: 'a1' });
    assert.equal(view.hash, log.hashAt(3));
  });
});

test('CLI: asOf commands inside the JSONL drive output when no --as-of flag', () => {
  const body = [
    JSON.stringify({ op: 'append', id: 'a', ts: 1, data: null }),
    JSON.stringify({ op: 'revoke', id: 'r', ts: 2, targetId: 'a' }),
    JSON.stringify({ op: 'asOf', ts: 1 }),
    JSON.stringify({ op: 'asOf', ts: 2 }),
    '',
  ].join('\n');
  withTempFile(body, (file) => {
    const { code, stdout } = captureCli(['node', 'cli.js', file]);
    assert.equal(code, 0);
    const views = stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(views.length, 2);
    assert.deepEqual(views[0].visible.map((e) => e.id), ['a']);
    assert.deepEqual(views[1].visible.map((e) => e.id), ['r']);
  });
});

test('CLI: revoke cycle exits 1 with E_REVOKE_CYCLE on stderr', () => {
  const body = [
    JSON.stringify({ op: 'revoke', id: 'r1', ts: 1, targetId: 'r2' }),
    JSON.stringify({ op: 'revoke', id: 'r2', ts: 2, targetId: 'r1' }),
    '',
  ].join('\n');
  withTempFile(body, (file) => {
    const { code, stdout, stderr } = captureCli(['node', 'cli.js', file]);
    assert.equal(code, 1);
    assert.match(stderr, /E_REVOKE_CYCLE/);
    assert.equal(stdout, '');
  });
});

test('CLI: malformed JSONL exits 1 with E_PARSE on stderr', () => {
  withTempFile('{"op":"append","id":"a","ts":1}\nnot json\n', (file) => {
    const { code, stderr } = captureCli(['node', 'cli.js', file]);
    assert.equal(code, 1);
    assert.match(stderr, /E_PARSE/);
  });
});

test('immutability: committed entries cannot be mutated', () => {
  const log = new AuditLog();
  const e = log.apply({ op: 'append', id: 'a', ts: 1, data: 1 });
  assert.throws(() => {
    e.data = 999;
  }, TypeError);
  assert.equal(log.viewAt(1).visible[0].data, 1);
});
