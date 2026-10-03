'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { tmpFile, cli } = require('./helpers');
const {
  commitLayer,
  commitCheckpoint,
  restore,
  verify,
  readIndex,
  indexPathOf,
} = require('../src/store');
const { encodeChunk, chunkHash, HEADER_LEN } = require('../src/chunk');
const { initialState, applyLayer } = require('../src/state');

// Acceptance 1: commit 10 layers; after every layer, recompute the full
// state from the data file and compare against an in-memory reference.
test('acceptance 1: full recompute after each of 10 layers matches reference', () => {
  const file = tmpFile('layers');
  const plans = [
    { kind: 'reserve', txs: [
      { op: 'credit', account: 'alice', amount: 1000, id: 'c1' },
      { op: 'reserve', account: 'alice', amount: 200, id: 'r1' },
    ] },
    { kind: 'freeze', txs: [{ op: 'freeze', account: 'alice', amount: 150, id: 'f1' }] },
    { kind: 'pay', txs: [{ op: 'pay', account: 'alice', amount: 150, ref: 'f1', id: 'p1' }] },
    { kind: 'checkpoint' },
    { kind: 'reserve', txs: [
      { op: 'credit', account: 'bob', amount: 500, id: 'c2' },
      { op: 'reserve', account: 'bob', amount: 90, id: 'r2' },
    ] },
    { kind: 'freeze', txs: [{ op: 'freeze', account: 'bob', amount: 120, id: 'f2' }] },
    { kind: 'pay', txs: [{ op: 'pay', account: 'bob', amount: 120, ref: 'f2', id: 'p2' }] },
    { kind: 'revert', txs: [{ op: 'revert', ref: 'p2', id: 'rv1' }] },
    { kind: 'freeze', txs: [{ op: 'freeze', account: 'alice', amount: 80, id: 'f3' }] },
    { kind: 'pay', txs: [{ op: 'pay', account: 'alice', amount: 80, ref: 'f3', id: 'p3' }] },
  ];
  assert.ok(plans.length <= 10);

  let expected = initialState();
  plans.forEach((plan, i) => {
    const seq = i + 1;
    if (plan.kind === 'checkpoint') {
      commitCheckpoint(file);
      expected = { ...structuredClone(expected), seq, lastCheckpointSeq: seq };
    } else {
      commitLayer(file, plan.kind, plan.txs);
      expected = applyLayer(expected, plan.kind, plan.txs, seq);
    }
    const { state } = restore(file, {}); // full replay from genesis
    assert.deepEqual(state, expected, `state mismatch after layer ${seq}`);
    const fast = restore(file, { checkpoint: true, strict: true });
    assert.deepEqual(fast.state, expected, `checkpoint restore mismatch after layer ${seq}`);
  });

  const report = verify(file);
  assert.equal(report.ok, true);
  assert.equal(report.layers, 10);
  assert.deepEqual(report.orphans, []);
});

// Acceptance 2: simulate a crash after a partial layer write. The linked
// chain must contain no half layer; the unlinked chunk is reported as an
// orphan and never merged into state.
test('acceptance 2: crash after partial layer write leaves no half layer, orphan reported', () => {
  const file = tmpFile('crash');
  commitLayer(file, 'reserve', [
    { op: 'credit', account: 'alice', amount: 300, id: 'c1' },
    { op: 'reserve', account: 'alice', amount: 100, id: 'r1' },
  ]);
  commitLayer(file, 'freeze', [{ op: 'freeze', account: 'alice', amount: 60, id: 'f1' }]);
  commitLayer(file, 'pay', [{ op: 'pay', account: 'alice', amount: 60, ref: 'f1', id: 'p1' }]);

  // Crash scenario A: full chunk written to the data file, process died
  // before the index line was appended -> orphan.
  const lastEntry = readIndex(file).at(-1);
  const orphanTxs = [{ op: 'freeze', account: 'alice', amount: 25, id: 'f-orphan' }];
  const orphanChunk = encodeChunk({ kind: 'freeze', seq: 4, parentHash: lastEntry.hash, payload: { txs: orphanTxs } });
  fs.appendFileSync(file, orphanChunk);

  // Crash scenario B: torn write, only part of the chunk hit the disk.
  const tornChunk = encodeChunk({ kind: 'pay', seq: 5, parentHash: chunkHash(orphanChunk), payload: { txs: [] } });
  const tornBytes = 30;
  fs.appendFileSync(file, tornChunk.subarray(0, tornBytes));

  const report = verify(file);
  assert.equal(report.ok, true, `linked chain must stay intact: ${JSON.stringify(report.errors)}`);
  assert.equal(report.layers, 3, 'no half layer may appear in the linked chain');
  assert.equal(report.lastSeq, 3);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0].seq, 4);
  assert.equal(report.orphans[0].kind, 'freeze');
  assert.equal(report.tornBytes, tornBytes);

  // Recovery never merges the orphan into state.
  const { state } = restore(file, {});
  assert.equal(state.seq, 3);
  assert.equal(state.accounts.alice.frozen, 0, 'orphan freeze must not be applied');
  assert.equal(state.freezes['f-orphan'], undefined);

  // The ledger still accepts new layers after the crash.
  const next = commitLayer(file, 'freeze', [{ op: 'freeze', account: 'alice', amount: 10, id: 'f2' }]);
  assert.equal(next.seq, 4);
  assert.equal(restore(file, {}).state.accounts.alice.frozen, 10);
});

// Acceptance 3: CRC corruption in a middle layer. An older checkpoint still
// restores; jumping to/past the corrupt layer fails with exit code 2.
test('acceptance 3: corrupt middle layer - old checkpoint restores, jumping past fails', () => {
  const file = tmpFile('corrupt');
  commitLayer(file, 'reserve', [
    { op: 'credit', account: 'alice', amount: 500, id: 'c1' },
    { op: 'reserve', account: 'alice', amount: 50, id: 'r1' },
  ]); // 1
  commitLayer(file, 'freeze', [{ op: 'freeze', account: 'alice', amount: 40, id: 'f1' }]); // 2
  commitCheckpoint(file); // 3
  commitLayer(file, 'pay', [{ op: 'pay', account: 'alice', amount: 40, ref: 'f1', id: 'p1' }]); // 4
  commitLayer(file, 'freeze', [{ op: 'freeze', account: 'alice', amount: 30, id: 'f2' }]); // 5
  commitLayer(file, 'pay', [{ op: 'pay', account: 'alice', amount: 30, ref: 'f2', id: 'p2' }]); // 6

  const stateAt4 = restore(file, { checkpoint: true, to: 4 }).state;

  // Corrupt one payload byte of layer 5 (structure stays scannable).
  const entry5 = readIndex(file).find((e) => e.seq === 5);
  const fd = fs.openSync(file, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, entry5.offset + HEADER_LEN);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, entry5.offset + HEADER_LEN);
  fs.closeSync(fd);

  // verify reports the corruption with exit code 2.
  const v = cli(['verify', file]);
  assert.equal(v.code, 2);
  assert.equal(v.json.ok, false);
  assert.ok(v.json.errors.some((e) => e.type === 'CRC_MISMATCH' && e.seq === 5));

  // Old checkpoint (seq 3, before the corrupt layer) still restores.
  const atCp = cli(['restore', file, '--checkpoint', '--to', '3']);
  assert.equal(atCp.code, 0, atCp.stderr);
  assert.equal(atCp.json.state.seq, 3);

  // Default checkpoint restore decodes the checkpoint plus following valid
  // deltas and stops cleanly before the corrupt layer.
  const def = cli(['restore', file, '--checkpoint']);
  assert.equal(def.code, 0, def.stderr);
  assert.equal(def.json.state.seq, 4);
  assert.deepEqual(def.json.state, stateAt4);
  assert.equal(def.json.stoppedAtCorruption.seq, 5);

  // Jumping to the corrupt layer or beyond fails with exit code 2.
  for (const to of ['5', '6']) {
    const r = cli(['restore', file, '--checkpoint', '--to', to]);
    assert.equal(r.code, 2, `restore --to ${to} must fail`);
  }

  // Full replay hits the corrupt layer and fails with exit code 2.
  const full = cli(['restore', file]);
  assert.equal(full.code, 2);
});

test('cli: business errors exit 1, corruption exits 2', () => {
  const file = tmpFile('exit');
  assert.equal(cli(['reserve', file, '--tx', 'credit:alice:100', '--tx', 'reserve:alice:10']).code, 0);

  // freeze beyond available -> business error
  const over = cli(['freeze', file, '--account', 'alice', '--amount', '500']);
  assert.equal(over.code, 1);
  assert.match(over.stderr, /insufficient available/);

  // pay at layer 3, checkpoint at 4: reverting the pay is a business error
  assert.equal(cli(['freeze', file, '--account', 'alice', '--amount', '20', '--id', 'f1']).code, 0);
  assert.equal(cli(['pay', file, '--account', 'alice', '--amount', '20', '--ref', 'f1', '--id', 'p1']).code, 0);
  assert.equal(cli(['checkpoint', file]).code, 0);
  const forbidden = cli(['revert', file, '--ref', 'p1']);
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.stderr, /checkpoint/);

  // a pay after the checkpoint can be reverted
  assert.equal(cli(['freeze', file, '--account', 'alice', '--amount', '15', '--id', 'f2']).code, 0);
  assert.equal(cli(['pay', file, '--account', 'alice', '--amount', '15', '--ref', 'f2', '--id', 'p2']).code, 0);
  const ok = cli(['revert', file, '--ref', 'p2']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.state.accounts.alice.balance, 80);

  // index corruption: point the last entry at a wrong offset
  const idxFile = indexPathOf(file);
  const lines = fs.readFileSync(idxFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  last.offset = 3;
  lines[lines.length - 1] = JSON.stringify(last);
  fs.writeFileSync(idxFile, `${lines.join('\n')}\n`);
  assert.equal(cli(['verify', file]).code, 2);
  assert.equal(cli(['restore', file]).code, 2);
});
