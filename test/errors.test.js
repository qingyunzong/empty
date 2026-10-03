'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir, makeConfig, makeStore, submitEvent, engine } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'evpack.js');

test('broken hash chain rejected with exit 4 and state unchanged', () => {
  const store = makeStore();
  const config = makeConfig();
  const seqBefore = store.state.seq;
  const bad = submitEvent('p-bad', { chain: ['f'.repeat(64)] });
  assert.throws(
    () => engine.execute(store, config, 'submit', [bad]),
    (err) => err.code === 'hash-chain-broken' && err.exitCode === 4
  );
  assert.equal(store.state.seq, seqBefore, 'state seq unchanged');
  assert.deepEqual(store.state.packs, {}, 'no pack persisted');
});

test('forged quota rejected with exit 4 and state unchanged', () => {
  const store = makeStore();
  const config = makeConfig();
  const seqBefore = store.state.seq;
  const greedy = submitEvent('p-fat', { size: 1000 });
  assert.throws(
    () => engine.execute(store, config, 'submit', [greedy]),
    (err) => err.code === 'quota-forged' && err.exitCode === 4
  );
  const unknown = submitEvent('p-ghost', { tenant: 'ghost' });
  assert.throws(
    () => engine.execute(store, config, 'submit', [unknown]),
    (err) => err.code === 'quota-forged' && err.exitCode === 4
  );
  assert.equal(store.state.seq, seqBefore);
  assert.deepEqual(store.state.packs, {});
});

test('duplicate pack rejected with exit 4 and state unchanged', () => {
  const store = makeStore();
  const config = makeConfig();
  engine.execute(store, config, 'submit', [submitEvent('p1', { lamport: 1 })]);
  const seqBefore = store.state.seq;
  const rootBefore = store.stateRoot();
  assert.throws(
    () => engine.execute(store, config, 'submit', [submitEvent('p1', { lamport: 2 })]),
    (err) => err.code === 'duplicate-pack' && err.exitCode === 4
  );
  assert.equal(store.state.seq, seqBefore);
  assert.equal(store.stateRoot(), rootBefore, 'state root unchanged');
});

test('CLI exits 4 on validation errors and leaves state unchanged', () => {
  const dir = tmpDir();
  const eventsFile = path.join(dir, 'events.json');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(eventsFile, JSON.stringify([submitEvent('p-bad', { chain: ['0'.repeat(64)] })]));
  fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
  const outFile = path.join(dir, 'stdout.txt');
  const run = spawnSync(
    'bash',
    ['-c', `"${process.execPath}" "${CLI}" submit --state "${dir}" --events "${eventsFile}" --config "${configFile}" > "${outFile}"; echo $?`],
    { encoding: 'utf8' }
  );
  const exitCode = Number(run.stdout.trim());
  const stdout = fs.readFileSync(outFile, 'utf8');
  assert.equal(exitCode, 4, 'CLI exit code 4');
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'hash-chain-broken');
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'no state file written');
});

test('concurrent submissions are ordered by (lamport, client, hash)', () => {
  const store = makeStore();
  const config = makeConfig();
  const events = [
    submitEvent('p3', { lamport: 2, client: 'cli-b', hash: 'aaa' }),
    submitEvent('p1', { lamport: 1, client: 'cli-z', hash: 'zzz' }),
    submitEvent('p2', { lamport: 1, client: 'cli-a', hash: 'mmm' }),
    submitEvent('p0', { lamport: 1, client: 'cli-a', hash: 'aaa' }),
  ];
  const r = engine.execute(store, config, 'submit', events);
  const order = r.results.map((x) => x.packId);
  assert.deepEqual(order, ['p0', 'p2', 'p1', 'p3'], 'sorted by (lamport, client, hash)');
  const walOrder = store.state.wal.map((w) => w.seq);
  assert.deepEqual(walOrder, [1], 'single atomic command, one wal entry');
});
