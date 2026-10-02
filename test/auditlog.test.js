'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AuditLog,
  AuditError,
  canonicalize,
  hashVisible,
} = require('../auditlog.js');
const { run: runCli } = require('../cli.js');


function visibleIds(view) {
  return view.visible.map((e) => e.id);
}

function revokedHiddenIds(view) {
  return view.hidden.filter((h) => h.reason === 'revoked').map((h) => h.id);
}

test('1. revoke changes the view across its timestamp', () => {
  const log = new AuditLog();
  log.addAppend({ id: 'a1', t: 1, data: { note: 'keep' } });
  log.addAppend({ id: 'a2', t: 2, data: { note: 'mistake' } });
  log.addRevoke({ id: 'r1', t: 3, targetId: 'a2' });

  const before = log.computeView(2);
  const after = log.computeView(3);

  assert.deepEqual(visibleIds(before), ['a1', 'a2']);
  assert.deepEqual(visibleIds(after), ['a1', 'r1']);
  assert.deepEqual(revokedHiddenIds(after), ['a2']);
  assert.equal(after.hidden.find((h) => h.id === 'a2').by, 'r1');
  assert.notEqual(before.hash, after.hash);
});

test('2. revoking a revoke restores visibility and the original hash', () => {
  const log = new AuditLog();
  log.addAppend({ id: 'a1', t: 1, data: { note: 'x' } });
  log.addRevoke({ id: 'r1', t: 2, targetId: 'a1' });
  log.addRevoke({ id: 'r2', t: 3, targetId: 'r1' });

  assert.deepEqual(visibleIds(log.computeView(2)), ['r1']);
  const restored = log.computeView(3);
  assert.deepEqual(visibleIds(restored), ['a1', 'r2']);
  assert.deepEqual(revokedHiddenIds(restored), ['r1']);
  // State hash depends only on visible entries: a1 visible again, r1 hidden,
  // so the hash equals the view where only a1 and r2 exist visibly.
  assert.equal(restored.hash, hashVisible([log.byId.get('a1'), log.byId.get('r2')]));

  // Longer cascade: r3 revokes r2 -> r1 effective again -> a1 hidden again.
  log.addRevoke({ id: 'r3', t: 4, targetId: 'r2' });
  const reHidden = log.computeView(4);
  assert.deepEqual(visibleIds(reHidden), ['r1', 'r3']);
  assert.deepEqual(revokedHiddenIds(reHidden).sort(), ['a1', 'r2']);
});

test('3. revoke cycles are rejected with E_REVOKE_CYCLE', () => {
  const log = new AuditLog();
  log.addRevoke({ id: 'r1', t: 1, targetId: 'r2' }); // forward reference allowed
  assert.throws(() => log.addRevoke({ id: 'r2', t: 2, targetId: 'r1' }), (err) => {
    assert.ok(err instanceof AuditError);
    assert.equal(err.code, 'E_REVOKE_CYCLE');
    return true;
  });
  // Self-revoke is a degenerate cycle.
  assert.throws(
    () => log.addRevoke({ id: 'r9', t: 3, targetId: 'r9' }),
    (err) => err instanceof AuditError && err.code === 'E_REVOKE_CYCLE',
  );
  // Three-node cycle.
  const log3 = new AuditLog();
  log3.addRevoke({ id: 'x1', t: 1, targetId: 'x3' });
  log3.addRevoke({ id: 'x2', t: 2, targetId: 'x1' });
  assert.throws(
    () => log3.addRevoke({ id: 'x3', t: 3, targetId: 'x2' }),
    (err) => err instanceof AuditError && err.code === 'E_REVOKE_CYCLE',
  );
});

// --- Reference implementation: independent replay + fixpoint iteration ---
// For each asOf, replays from scratch and solves visibility by iterating the
// equation hidden(e) = OR over revokers r of e of (NOT hidden(r)) starting
// from "nothing hidden" until a fixpoint (guaranteed within n+1 rounds on a
// cycle-free revoke graph).
function referenceView(entries, asOf) {
  const present = entries.filter((e) => e.t <= asOf);
  let hidden = new Set();
  for (let round = 0; round <= present.length + 1; round++) {
    const next = new Set();
    for (const e of present) {
      const hasEffectiveRevoker = present.some(
        (r) => r.op === 'revoke' && r.targetId === e.id && !hidden.has(r.id),
      );
      if (hasEffectiveRevoker) next.add(e.id);
    }
    if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) break;
    hidden = next;
  }
  const visible = present.filter((e) => !hidden.has(e.id));
  return {
    visibleIds: visible.map((e) => e.id),
    hiddenIds: present.filter((e) => hidden.has(e.id)).map((e) => e.id),
    hash: hashVisible(visible),
  };
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

test('4. randomized logs (n<=8) match reference replay at every asOf', () => {
  for (let n = 1; n <= 8; n++) {
    for (let trial = 0; trial < 150; trial++) {
      const rng = mulberry32(n * 1000003 + trial);
      const log = new AuditLog();
      const ids = [];
      for (let i = 0; i < n; i++) {
        const t = i + 1;
        const id = `e${t}`;
        const wantRevoke = rng() < 0.5;
        if (wantRevoke) {
          // Mix of past ids, dangling ids and forward references.
          let targetId;
          const pick = rng();
          if (pick < 0.55 && ids.length > 0) {
            targetId = ids[Math.floor(rng() * ids.length)];
          } else if (pick < 0.8) {
            targetId = `e${1 + Math.floor(rng() * n)}`;
          } else {
            targetId = `ghost${Math.floor(rng() * 3)}`;
          }
          try {
            log.addRevoke({ id, t, targetId });
            ids.push(id);
            continue;
          } catch (err) {
            assert.ok(err instanceof AuditError);
            assert.equal(err.code, 'E_REVOKE_CYCLE');
          }
        }
        log.addAppend({ id, t, data: { v: Math.floor(rng() * 1000), tag: `t${trial}` } });
        ids.push(id);
      }

      for (let asOf = 0; asOf <= n + 1; asOf++) {
        const view = log.computeView(asOf);
        const ref = referenceView(log.entries, asOf);
        const ctx = `n=${n} trial=${trial} asOf=${asOf} entries=${JSON.stringify(log.entries)}`;
        assert.deepEqual(visibleIds(view), ref.visibleIds, `visible mismatch: ${ctx}`);
        assert.deepEqual(revokedHiddenIds(view).sort(), [...ref.hiddenIds].sort(), `hidden mismatch: ${ctx}`);
        assert.equal(view.hash, ref.hash, `hash mismatch: ${ctx}`);
        assert.equal(view.hash, hashVisible(view.visible), `hash not derived from visible only: ${ctx}`);
        assert.deepEqual(
          view.hidden.filter((h) => h.reason === 'after-as-of').map((h) => h.id),
          log.entries.filter((e) => e.t > asOf).map((e) => e.id),
          `after-as-of mismatch: ${ctx}`,
        );
      }
    }
  }
});

// --- CLI end-to-end tests ---

function runCliCaptured(args) {
  let stdout = '';
  let stderr = '';
  const status = runCli(args, (s) => { stdout += s; }, (s) => { stderr += s; });
  return { status, stdout, stderr };
}

function withTempFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditlog-'));
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI prints views for asOf commands and --as-of', () => {
  const fileContents = [
    JSON.stringify({ op: 'append', id: 'a1', t: 1, data: { note: 'ok' } }),
    JSON.stringify({ op: 'append', id: 'a2', t: 2, data: { note: 'bad' } }),
    JSON.stringify({ op: 'revoke', id: 'r1', t: 3, targetId: 'a2' }),
    JSON.stringify({ op: 'asOf', t: 2 }),
    '',
  ].join('\n');
  withTempFile(fileContents, (file) => {
    const res = runCliCaptured([file, '--as-of', '3']);
    assert.equal(res.status, 0, res.stderr);
    const views = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(views.length, 2);
    assert.equal(views[0].type, 'view');
    assert.equal(views[0].asOf, 2);
    assert.deepEqual(views[0].visible.map((e) => e.id), ['a1', 'a2']);
    assert.equal(views[1].asOf, 3);
    assert.deepEqual(views[1].visible.map((e) => e.id), ['a1', 'r1']);
    assert.deepEqual(views[1].hidden, [{ id: 'a2', reason: 'revoked', by: 'r1' }]);
    assert.match(views[1].hash, /^[0-9a-f]{64}$/);
    assert.notEqual(views[0].hash, views[1].hash);
  });
});

test('CLI reports E_REVOKE_CYCLE on stderr with exit code 1', () => {
  const fileContents = [
    JSON.stringify({ op: 'revoke', id: 'r1', t: 1, targetId: 'r2' }),
    JSON.stringify({ op: 'revoke', id: 'r2', t: 2, targetId: 'r1' }),
    '',
  ].join('\n');
  withTempFile(fileContents, (file) => {
    const res = runCliCaptured([file]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /E_REVOKE_CYCLE/);
  });
});

test('CLI reports parse and schema errors on stderr with exit code 1', () => {
  withTempFile('{"op":"append","id":"a1","t":1}\nnot json\n', (file) => {
    const res = runCliCaptured([file]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /E_PARSE/);
  });
  withTempFile('{"op":"append","id":"a1","t":1}\n{"op":"append","id":"a1","t":2}\n', (file) => {
    const res = runCliCaptured([file]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /E_DUPLICATE_ID/);
  });
  withTempFile('{"op":"append","id":"a1","t":5}\n{"op":"append","id":"a2","t":5}\n', (file) => {
    const res = runCliCaptured([file]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /E_ORDER/);
  });
  const res = runCliCaptured([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_ARGS/);
});

test('canonicalize is key-order independent', () => {
  const a = canonicalize({ b: 1, a: { d: [1, 2], c: 'x' } });
  const b = canonicalize({ a: { c: 'x', d: [1, 2] }, b: 1 });
  assert.equal(a, b);
});
