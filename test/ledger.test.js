import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LedgerStore, LedgerError, CrashSimulated, stateHash } from '../src/ledger.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));


function spawnCli(args) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-')), 'out.txt');
  const fd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  return { status: res.status, stdout: fs.readFileSync(outFile, 'utf8') };
}


// node --test swallows child stdout in this environment; synchronous writes to
// fd 2 are forwarded by the runner, so recovery hashes genuinely reach test-result.txt.
function emit(t, msg) {
  t.diagnostic(msg);
  fs.writeSync(2, `${msg}\n`);
}

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  return path.join(dir, 'ledger.json');
}

function freshStore(file) {
  const store = new LedgerStore(file);
  store.recover();
  return store;
}

function statuses(store) {
  return Object.fromEntries(store.snapshot().entries.map((e) => [e.entryId, e.status]));
}

test('submit/cancel/settle basic flow with correct nets', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'A', amount: 40 });
  store.submit({ entryId: 'e3', payer: 'C', payee: 'A', amount: 10 });
  store.cancel('e3');
  assert.deepEqual(store.computeNets(), { A: -60, B: 60 });
  const result = store.settle();
  assert.deepEqual(result.nets, { A: -60, B: 60 });
  assert.deepEqual(statuses(store), { e1: 'settled', e2: 'settled', e3: 'cancelled' });
  // state survives recovery via valid snapshot + watermark
  const recovered = freshStore(file);
  assert.deepEqual(statuses(recovered), statuses(store));
  assert.equal(recovered.recoveryHash(), store.recoveryHash());
});

test('duplicate entryId submission is idempotent', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  const hashBefore = store.recoveryHash();
  const again = store.submit({ entryId: 'e1', payer: 'X', payee: 'Y', amount: 999 });
  assert.equal(again.payer, 'A'); // original kept
  assert.equal(store.recoveryHash(), hashBefore);
  assert.equal(store.snapshot().entries.length, 1);
  // idempotent across recovery as well
  const recovered = freshStore(file);
  recovered.submit({ entryId: 'e1', payer: 'Z', payee: 'W', amount: 1 });
  assert.equal(recovered.snapshot().entries.length, 1);
  assert.equal(recovered.recoveryHash(), hashBefore);
});

test('cancel of settled entry rejected with ENTRY_NOT_PENDING and no state change', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.settle();
  const hashBefore = store.recoveryHash();
  assert.throws(() => store.cancel('e1'), (err) => err instanceof LedgerError && err.code === 'ENTRY_NOT_PENDING');
  assert.equal(store.recoveryHash(), hashBefore);
  assert.equal(statuses(store).e1, 'settled');
  const recovered = freshStore(file);
  assert.equal(recovered.recoveryHash(), hashBefore);
});

test('cancel of cancelled entry rejected; cancel of unknown entry rejected', (t) => {
  const store = freshStore(tmpLedger());
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 5 });
  store.cancel('e1');
  assert.throws(() => store.cancel('e1'), (err) => err.code === 'ENTRY_NOT_PENDING');
  assert.throws(() => store.cancel('nope'), (err) => err.code === 'ENTRY_NOT_FOUND');
});

test('crash beforeRename: no entry becomes settled after recovery', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'C', amount: 30 });
  store.crashPoint = 'beforeRename';
  assert.throws(() => store.settle(), (err) => err instanceof CrashSimulated && err.point === 'beforeRename');
  const recovered = freshStore(file);
  assert.deepEqual(statuses(recovered), { e1: 'pending', e2: 'pending' });
  emit(t, `recoveryHash=${recovered.recoveryHash()} point=beforeRename`);
});

test('crash afterRename: restart must present all entries settled', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'C', amount: 30 });
  store.crashPoint = 'afterRename';
  assert.throws(() => store.settle(), (err) => err instanceof CrashSimulated && err.point === 'afterRename');
  const recovered = freshStore(file);
  assert.deepEqual(statuses(recovered), { e1: 'settled', e2: 'settled' });
  emit(t, `recoveryHash=${recovered.recoveryHash()} point=afterRename`);
});

test('corrupt watermark: snapshot ignored, full changelog replayed', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'A', amount: 25 });
  store.settle();
  const expected = store.recoveryHash();
  fs.writeFileSync(`${file}.watermark`, '}{not json at all');
  const recovered = freshStore(file);
  assert.equal(recovered.recoveryHash(), expected);
  assert.deepEqual(statuses(recovered), { e1: 'settled', e2: 'settled' });
  // missing watermark behaves the same
  fs.rmSync(`${file}.watermark`);
  assert.equal(freshStore(file).recoveryHash(), expected);
  emit(t, `recoveryHash=${expected} scenario=corrupt-watermark`);
});

test('corrupt snapshot: recovered from changelog alone', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.cancel('e1');
  store.submit({ entryId: 'e2', payer: 'B', payee: 'A', amount: 7 });
  store.settle();
  const expected = store.recoveryHash();
  fs.writeFileSync(file, 'garbage-bytes-not-a-snapshot');
  const recovered = freshStore(file);
  assert.equal(recovered.recoveryHash(), expected);
  assert.deepEqual(statuses(recovered), { e1: 'cancelled', e2: 'settled' });
  emit(t, `recoveryHash=${expected} scenario=corrupt-snapshot`);
});

test('CLI run --crash settle:beforeRename then recover (real process crash)', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'A', amount: 40 });

  const crashed = spawnCli(['run', file, '--crash', 'settle:beforeRename']);
  assert.equal(crashed.status, 75);

  const rec = spawnCli(['recover', file]);
  assert.equal(rec.status, 0);
  assert.match(rec.stdout, /entry e1 A->B 100 pending/);
  assert.match(rec.stdout, /entry e2 B->A 40 pending/);
  const hash = rec.stdout.match(/recoveryHash=([0-9a-f]{64})/)[1];
  assert.equal(hash, freshStore(file).recoveryHash());
  emit(t, `recoveryHash=${hash} cli=beforeRename`);
});

test('CLI run --crash settle:afterRename then recover (real process crash)', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'A', amount: 40 });

  const crashed = spawnCli(['run', file, '--crash', 'settle:afterRename']);
  assert.equal(crashed.status, 75);

  const rec = spawnCli(['recover', file]);
  assert.equal(rec.status, 0);
  assert.match(rec.stdout, /entry e1 A->B 100 settled/);
  assert.match(rec.stdout, /entry e2 B->A 40 settled/);
  const hash = rec.stdout.match(/recoveryHash=([0-9a-f]{64})/)[1];
  assert.equal(hash, freshStore(file).recoveryHash());
  emit(t, `recoveryHash=${hash} cli=afterRename`);
});

test('CLI run without crash settles and prints nets', (t) => {
  const file = tmpLedger();
  const store = freshStore(file);
  store.submit({ entryId: 'e1', payer: 'A', payee: 'B', amount: 100 });
  store.submit({ entryId: 'e2', payer: 'B', payee: 'A', amount: 40 });
  const run = spawnCli(['run', file]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /net A=-60/);
  assert.match(run.stdout, /net B=60/);
  assert.match(run.stdout, /recoveryHash=[0-9a-f]{64}/);
});

// Exhaustive cross-check: for n = 1..6 entries, enumerate every crash point
// (none / beforeRename / afterRename) against cancel subsets in ascending and
// descending order, comparing recovered state and hash against an independent model.
test('exhaustive enumeration: <=6 entries x crash points x cancel orders', (t) => {
  const participants = ['A', 'B', 'C'];
  const crashPoints = [null, 'beforeRename', 'afterRename'];
  let cases = 0;

  for (let n = 1; n <= 6; n += 1) {
    const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
    const subsets = [[]];
    for (const id of ids) {
      for (const s of subsets.slice()) subsets.push([...s, id]);
    }
    const cancelSequences = subsets.flatMap((s) => {
      const asc = [...s].sort();
      const desc = [...asc].reverse();
      return asc.join() === desc.join() ? [asc] : [asc, desc];
    });

    for (const cancels of cancelSequences) {
      for (const point of crashPoints) {
        const file = tmpLedger();
        const store = freshStore(file);
        const model = new Map();
        ids.forEach((id, i) => {
          const entry = {
            entryId: id,
            payer: participants[i % 3],
            payee: participants[(i + 1) % 3],
            amount: (i + 1) * 10,
            status: 'pending',
          };
          store.submit(entry);
          model.set(id, { ...entry });
        });
        for (const id of cancels) {
          store.cancel(id);
          model.get(id).status = 'cancelled';
        }
        store.crashPoint = point;
        try {
          store.settle();
          for (const e of model.values()) {
            if (e.status === 'pending') e.status = 'settled';
          }
        } catch (err) {
          assert.ok(err instanceof CrashSimulated, `unexpected ${err}`);
          if (point === 'afterRename') {
            for (const e of model.values()) {
              if (e.status === 'pending') e.status = 'settled';
            }
          }
          // beforeRename: model keeps pending entries untouched
        }
        const recovered = freshStore(file);
        const expectedHash = stateHash(model);
        assert.equal(
          recovered.recoveryHash(),
          expectedHash,
          `n=${n} cancels=${cancels} point=${point}`,
        );
        assert.deepEqual(statuses(recovered), Object.fromEntries([...model.entries()].map(([k, v]) => [k, v.status])));
        if (point) emit(t, `recoveryHash=${expectedHash} n=${n} cancels=${cancels.join('+') || '-'} point=${point}`);
        cases += 1;
      }
    }
  }
  assert.ok(cases > 0);
  emit(t, `enumeration cases=${cases}`);
});
