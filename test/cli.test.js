'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCommand } = require('../cli');

// Drives the CLI dispatch layer in-process, threading the persisted state
// exactly as cli.js main() does between invocations.
function session() {
  let state = null;
  return (cmd, payload) => {
    const result = runCommand(cmd, payload === undefined ? {} : payload, state);
    if (result.code === 0 && result.persist) state = result.state;
    return result;
  };
}

test('CLI end-to-end: loadCurve/post/certify/verify, backdate invalidates', () => {
  const run = session();
  let r = run('loadCurve', {
    segments: [
      { from: 0, to: 2, coefs: [[1, 1]] },
      { from: 2, to: 5, coefs: [[0, 1], [1, 2]] },
    ],
  });
  assert.equal(r.code, 0);
  assert.equal(r.body.ok, true);

  r = run('post', { day: 0, amountNum: 1000, amountDen: 1 });
  assert.equal(r.code, 0);
  const postId = r.body.id;

  r = run('certify', { from: 0, to: 5 });
  assert.equal(r.code, 0);
  assert.equal(r.body.exactTotal, '7250');
  const certId = r.body.id;

  r = run('verify', { certId });
  assert.equal(r.code, 0);
  assert.equal(r.body.ok, true);

  // Uncovered range -> E_PENDING, exit code 1.
  r = run('certify', { from: 0, to: 9 });
  assert.equal(r.code, 1);
  assert.equal(r.body.error, 'E_PENDING');

  // Backdate -> old certificate stale.
  r = run('backdate', { day: 0, newAmount: 2000 });
  assert.equal(r.code, 0);
  r = run('verify', { certId });
  assert.equal(r.code, 1);
  assert.equal(r.body.error, 'E_CERT');

  // Undo restores the root captured before the extra posting.
  const rootBefore = run('root').body.root;
  const extra = run('post', { day: 1, amountNum: 5, amountDen: 1 }).body.id;
  assert.notEqual(run('root').body.root, rootBefore);
  run('undoPost', { id: extra });
  assert.equal(run('root').body.root, rootBefore);

  assert.ok(postId >= 1);
});
