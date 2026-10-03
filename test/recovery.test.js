'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGateway, CrashError } = require('../lib/run');
const { TYPE, encodeFrame } = require('../lib/frame');

// Six requests exercising reserve/commit/release/expire plus a TTL expiry
// and a late commit, so crashes can land mid-batch and around audit events.
function scenarioFrames() {
  const F = (type, member, reqId, amount, seq, tick) => encodeFrame({ type, member, reqId, amount, seq, tick });
  return Buffer.concat([
    F(TYPE.RESERVE, 'alice', 1, 400, 1, 0),
    F(TYPE.RESERVE, 'bob', 2, 300, 2, 0),
    F(TYPE.COMMIT, 'alice', 1, 100, 3, 1),
    F(TYPE.RELEASE, 'bob', 2, 0, 4, 2),
    F(TYPE.RESERVE, 'carol', 3, 50, 5, 30), // ttl 10 -> alice's remaining 300 expires here
    F(TYPE.COMMIT, 'alice', 1, 300, 6, 31), // late commit -> reject
  ]);
}

function freshRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-recovery-'));
  const input = path.join(dir, 'frames.bin');
  fs.writeFileSync(input, scenarioFrames());
  return (opts = {}) => {
    let stdout = '';
    let stderr = '';
    try {
      const code = runGateway({
        input, budget: 1000, ttl: 10,
        write: (s) => { stdout += s; },
        errWrite: (s) => { stderr += s; },
        ...opts,
      });
      return { code, stdout, stderr, crashed: false };
    } catch (err) {
      if (err instanceof CrashError) return { code: err.exitCode, stdout, stderr, crashed: true };
      throw err;
    }
  };
}

test('recovery: crash at any of the three points yields the unique clean-run result', (t) => {
  const clean = freshRun()({ fresh: true });
  assert.equal(clean.code, 0, clean.stderr);
  assert.ok(clean.stdout.includes('event=expire'));

  const cases = [];
  for (let n = 1; n <= 6; n++) cases.push(['log', n]);
  for (const n of [1, 3, 6]) cases.push(['pre', n], ['ack', n]);

  for (const [point, n] of cases) {
    const run = freshRun();
    const crashed = run({ fresh: true, crashAt: `${point}:${n}` });
    assert.equal(crashed.crashed, true, `${point}:${n} should crash`);
    assert.equal(crashed.code, 75);
    const recovered = run(); // existing log -> recovery
    assert.equal(recovered.code, clean.code, `${point}:${n} exit code`);
    assert.equal(recovered.stdout, clean.stdout, `${point}:${n} output must equal the clean run`);
    t.diagnostic(`${point}:${n} recovered identically`);
  }
});

test('recovery: log survives multiple crashes (crash, recover, crash again)', () => {
  const run = freshRun();
  assert.equal(run({ fresh: true, crashAt: 'log:2' }).crashed, true);
  assert.equal(run({ crashAt: 'ack:5' }).crashed, true); // recovers 1-2, crashes at 5
  const final = run();
  const clean = freshRun()({ fresh: true });
  assert.equal(final.stdout, clean.stdout);
  assert.equal(final.code, clean.code);
});

test('recovery: tampered log is rejected as corrupt (exit 2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-recovery-'));
  const input = path.join(dir, 'frames.bin');
  fs.writeFileSync(input, scenarioFrames());
  const run = (opts = {}) => {
    let stderr = '';
    const code = runGateway({ input, budget: 1000, ttl: 10, write: () => {}, errWrite: (s) => { stderr += s; }, ...opts });
    return { code, stderr };
  };
  assert.throws(() => runGateway({ input, budget: 1000, ttl: 10, crashAt: 'log:2', write: () => {} }), CrashError);
  const logPath = input + '.log';
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[0]);
  tampered.granted = 9999; // forge a decision
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  const res = run();
  assert.equal(res.code, 2);
  assert.match(res.stderr, /integrity/);
});
