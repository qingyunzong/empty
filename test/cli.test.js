import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
}

// Some sandboxes refuse to let Node spawn Node (EPERM). Fall back to running
// the CLI through bash with output redirected to files, which works there and
// behaves identically in unrestricted environments.
const CAN_SPAWN_NODE = (() => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    encoding: 'utf8',
  });
  return !r.error && r.stdout === 'ok';
})();

const shq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

function bashInvocation(args, env, outFile, errFile) {
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join(' ');
  const cmd = [process.execPath, ...args].map(shq).join(' ');
  return `${envPrefix} ${cmd} > ${shq(outFile)} 2> ${shq(errFile)}`;
}

function runCli(cliArgs, env = {}) {
  const fullArgs = [CLI, ...cliArgs];
  if (CAN_SPAWN_NODE) {
    const r = spawnSync(process.execPath, fullArgs, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), `cli-${id}.out`);
  const errFile = path.join(os.tmpdir(), `cli-${id}.err`);
  const rcFile = path.join(os.tmpdir(), `cli-${id}.rc`);
  spawnSync('bash', [
    '-c',
    `${bashInvocation(fullArgs, env, outFile, errFile)}; printf %s $? > ${shq(rcFile)}`,
  ]);
  const code = Number.parseInt(fs.readFileSync(rcFile, 'utf8'), 10);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  for (const f of [outFile, errFile, rcFile]) fs.rmSync(f, { force: true });
  return { code, stdout, stderr };
}

function runCliAsync(cliArgs, env = {}) {
  const fullArgs = [CLI, ...cliArgs];
  if (CAN_SPAWN_NODE) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, fullArgs, {
        env: { ...process.env, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }
  const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), `cli-${id}.out`);
  const errFile = path.join(os.tmpdir(), `cli-${id}.err`);
  const rcFile = path.join(os.tmpdir(), `cli-${id}.rc`);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [
      '-c',
      `${bashInvocation(fullArgs, env, outFile, errFile)}; printf %s $? > ${shq(rcFile)}`,
    ]);
    child.on('error', reject);
    child.on('close', () => {
      const code = Number.parseInt(fs.readFileSync(rcFile, 'utf8'), 10);
      const stdout = fs.readFileSync(outFile, 'utf8');
      const stderr = fs.readFileSync(errFile, 'utf8');
      for (const f of [outFile, errFile, rcFile]) fs.rmSync(f, { force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

function run(dir, args, env = {}) {
  const r = runCli(['--dir', dir, ...args], env);
  return {
    code: r.code,
    json: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null,
    stderr: r.stderr,
  };
}

async function runAsync(dir, args, env = {}) {
  const r = await runCliAsync(['--dir', dir, ...args], env);
  return {
    code: r.code,
    json: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null,
    stderr: r.stderr,
  };
}

const OPEN_SLIP = { id: 's1', merchantId: 'm1', amount: 100, status: 'OPEN' };

test('cli tx: puts then cancel, success prints {"version":n}', () => {
  const dir = tmpdir();
  const put = run(dir, ['tx', JSON.stringify({ puts: { 'settle:s1': OPEN_SLIP } })]);
  assert.equal(put.code, 0);
  assert.deepEqual(put.json, { version: 1 });

  const cancel = run(dir, ['tx', JSON.stringify({ cancel: 's1' })]);
  assert.equal(cancel.code, 0);
  assert.deepEqual(cancel.json, { version: 2 });

  const slip = run(dir, ['get', 'settle:s1']);
  assert.equal(slip.json.status, 'CANCELLED');
  const reversal = run(dir, ['get', 'reversal:s1']);
  assert.equal(reversal.json.kind, 'cancel');
  assert.equal(reversal.json.amount, 100);
  const debit = run(dir, ['get', 'entry:s1:reversal:debit']);
  assert.equal(debit.json.amount, -100);
  const credit = run(dir, ['get', 'entry:s1:reversal:credit']);
  assert.equal(credit.json.amount, 100);
});

test('cli tx failure prints {"error":CODE} and exits non-zero', () => {
  const dir = tmpdir();
  run(dir, ['tx', JSON.stringify({ puts: { 'settle:s1': OPEN_SLIP } })]);
  run(dir, ['tx', JSON.stringify({ cancel: 's1' })]);

  // Second cancel of a CANCELLED slip -> E_STATE, non-zero exit, nothing written.
  const again = run(dir, ['tx', JSON.stringify({ cancel: 's1' })]);
  assert.notEqual(again.code, 0);
  assert.deepEqual(again.json, { error: 'E_STATE' });

  const missing = run(dir, ['tx', JSON.stringify({ cancel: 'nope' })]);
  assert.notEqual(missing.code, 0);
  assert.deepEqual(missing.json, { error: 'E_NOT_FOUND' });

  // HEAD untouched by failed transactions.
  const state = run(dir, ['get']);
  assert.equal(state.json['settle:s1'].status, 'CANCELLED');
});

test('cli get --at exports historical versions', () => {
  const dir = tmpdir();
  run(dir, ['tx', JSON.stringify({ puts: { 'settle:s1': OPEN_SLIP } })]);
  run(dir, ['tx', JSON.stringify({ cancel: 's1' })]);

  const at1 = run(dir, ['get', 'settle:s1', '--at', '1']);
  assert.equal(at1.code, 0);
  assert.equal(at1.json.status, 'OPEN');
  const at2 = run(dir, ['get', 'settle:s1', '--at', '2']);
  assert.equal(at2.json.status, 'CANCELLED');

  // Whole-state export at a version.
  const dump1 = run(dir, ['get', '--at', '1']);
  assert.deepEqual(Object.keys(dump1.json).sort(), ['settle:s1']);
  const dump2 = run(dir, ['get', '--at', '2']);
  assert.ok('reversal:s1' in dump2.json);
  assert.ok('entry:s1:reversal:debit' in dump2.json);

  // Key not present at that version.
  const missing = run(dir, ['get', 'reversal:s1', '--at', '1']);
  assert.notEqual(missing.code, 0);
  assert.deepEqual(missing.json, { error: 'E_NOT_FOUND' });
});

async function waitForFile(file, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('cli processes racing to cancel one slip: exactly one wins', async () => {
  const dir = tmpdir();
  run(dir, ['tx', JSON.stringify({ puts: { 'settle:s1': OPEN_SLIP } })]);

  // Deterministic overlap: each process signals begin, both hold at the gate
  // until both have begun on the same snapshot, then race to commit.
  const beganA = path.join(dir, 'began-a');
  const beganB = path.join(dir, 'began-b');
  const gate = path.join(dir, 'gate');
  const p1 = runAsync(dir, ['tx', JSON.stringify({ cancel: 's1' })], {
    SETTLE_TX_BEGAN_FILE: beganA,
    SETTLE_TX_GATE_FILE: gate,
  });
  const p2 = runAsync(dir, ['tx', JSON.stringify({ cancel: 's1' })], {
    SETTLE_TX_BEGAN_FILE: beganB,
    SETTLE_TX_GATE_FILE: gate,
  });
  await waitForFile(beganA);
  await waitForFile(beganB);
  fs.writeFileSync(gate, 'go');
  const results = await Promise.all([p1, p2]);

  const winners = results.filter((r) => r.code === 0);
  const losers = results.filter((r) => r.code !== 0);
  assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(results)}`);
  assert.equal(losers.length, 1);
  assert.equal(typeof winners[0].json.version, 'number');
  assert.deepEqual(losers[0].json, { error: 'E_CONFLICT' });

  // Exactly one reversal exists in the final state.
  const state = run(dir, ['get']);
  assert.equal(state.json['settle:s1'].status, 'CANCELLED');
  assert.equal(state.json['reversal:s1'].slipId, 's1');
});

test('cli stale-snapshot cancel after settle: E_CONFLICT, no half reversal', async () => {
  const dir = tmpdir();
  run(dir, ['tx', JSON.stringify({ puts: { 'settle:s1': OPEN_SLIP } })]);

  // Canceller begins at v1 (slip OPEN) and holds at the gate; the settler
  // commits first; then the canceller is released and must lose.
  const began = path.join(dir, 'began');
  const gate = path.join(dir, 'gate');
  const canceller = runAsync(dir, ['tx', JSON.stringify({ cancel: 's1' })], {
    SETTLE_TX_BEGAN_FILE: began,
    SETTLE_TX_GATE_FILE: gate,
  });
  await waitForFile(began);
  const settler = run(dir, [
    'tx',
    JSON.stringify({
      puts: {
        'settle:s1': { ...OPEN_SLIP, status: 'SETTLED' },
        'acct:m1': { merchantId: 'm1', balance: 100 },
      },
    }),
  ]);
  assert.equal(settler.code, 0);
  fs.writeFileSync(gate, 'go');
  const lost = await canceller;
  assert.notEqual(lost.code, 0);
  assert.deepEqual(lost.json, { error: 'E_CONFLICT' });

  const state = run(dir, ['get']);
  assert.equal(state.json['settle:s1'].status, 'SETTLED');
  assert.equal(state.json['acct:m1'].balance, 100);
  assert.ok(!('reversal:s1' in state.json));
  assert.ok(!('entry:s1:reversal:debit' in state.json));
  assert.ok(!('entry:s1:reversal:credit' in state.json));
});
