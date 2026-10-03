import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { tempDir } from './helpers.js';

// Each run() call is one CLI invocation; state lives on disk, so sequential
// calls behave exactly like separate processes (including WAL recovery).
function run(dir, args) {
  let stdout = '';
  let stderr = '';
  const code = main(['--data', dir, ...args], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return {
    code,
    stdout,
    stderr,
    json: stdout ? JSON.parse(stdout) : null,
    errJson: stderr ? JSON.parse(stderr) : null,
  };
}

test('CLI happy path: init, add, prepare, commit, get', () => {
  const dir = tempDir();
  let r = run(dir, ['init', '--budget', '1000']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'OPEN');
  assert.equal(r.json.budget, 1000);

  r = run(dir, ['add', '--parent', 'root', '--id', 'g1', '--amount', '400']);
  assert.equal(r.code, 0);
  assert.equal(r.json.amount, 400);

  r = run(dir, ['prepare', 'g1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'PREPARED');
  assert.match(r.json.txId, /^tx-/);

  r = run(dir, ['commit', 'g1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'SETTLED');

  r = run(dir, ['get', 'g1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'SETTLED');

  r = run(dir, ['get', 'root']);
  assert.equal(r.json.settled, 400);
  assert.equal(r.json.available, 600);
});

test('CLI cancel reports blocked settled descendants as PARTIAL, exit 0', () => {
  const dir = tempDir();
  run(dir, ['init', '--budget', '1000']);
  run(dir, ['add', '--parent', 'root', '--id', 'open1', '--amount', '200']);
  run(dir, ['add', '--parent', 'root', '--id', 'done1', '--amount', '300']);
  run(dir, ['prepare', 'done1']);
  run(dir, ['commit', 'done1']);

  const r = run(dir, ['cancel', 'root']);
  assert.equal(r.code, 0, 'partial revocation is not a failure');
  assert.equal(r.json.state, 'PARTIAL');
  assert.deepEqual(r.json.cancelled, ['open1']);
  assert.deepEqual(r.json.kept, [{ id: 'done1', state: 'SETTLED' }]);
  assert.equal(r.json.blocked[0].id, 'done1');
  assert.match(r.json.blocked[0].reason, /ALREADY_SETTLED/);
});

test('CLI errors are JSON on stderr with non-zero exit', () => {
  const dir = tempDir();
  run(dir, ['init', '--budget', '1000']);

  let r = run(dir, ['get', 'nope']);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.errJson.error.code, 'GROUP_NOT_FOUND');

  r = run(dir, ['add', '--parent', 'root', '--id', 'big', '--amount', '9999']);
  assert.notEqual(r.code, 0);
  assert.equal(r.errJson.error.code, 'INSUFFICIENT_BUDGET');

  r = run(dir, ['commit', 'root']);
  assert.notEqual(r.code, 0);
  assert.equal(r.errJson.error.code, 'INVALID_STATE');

  r = run(dir, ['bogus-command']);
  assert.notEqual(r.code, 0);
  assert.equal(r.errJson.error.code, 'USAGE');
});

test('CLI crash --after-prepare exits non-zero and recovery rolls back', () => {
  const dir = tempDir();
  run(dir, ['init', '--budget', '1000']);
  run(dir, ['add', '--parent', 'root', '--id', 'p1', '--amount', '400']);

  const crash = run(dir, ['crash', '--after-prepare', 'p1']);
  assert.notEqual(crash.code, 0, 'simulated crash exits non-zero');
  assert.equal(crash.errJson.crash.phase, 'after-prepare');
  assert.equal(crash.errJson.crash.id, 'p1');

  // Next command triggers recovery: p1 is OPEN again, nothing deducted.
  let r = run(dir, ['get', 'p1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'OPEN');
  r = run(dir, ['get', 'root']);
  assert.equal(r.json.pending, 0);
  assert.equal(r.json.settled, 0);
  assert.equal(r.json.available, 600);

  // Resubmit succeeds.
  r = run(dir, ['prepare', 'p1']);
  assert.equal(r.code, 0);
  r = run(dir, ['commit', 'p1']);
  assert.equal(r.code, 0);
  r = run(dir, ['get', 'root']);
  assert.equal(r.json.settled, 400);
});
