'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JeError, mkTmp, writeFile, readJson, readLines, cli, captureThrow } = require('../testsupport/helpers');
const { Db } = require('../src/db');
const { compile } = require('../src/compiler');
const { check } = require('../src/checker');
const { parse } = require('../src/parser');
const { lex } = require('../src/lexer');
const vm = require('../src/vm');

const JE = `account 1001 "Cash";
account 2001 "Revenue";
period 2025-01 open;
batch SALE in 2025-01 on sale {
  post dr 1001 event.amount cr 2001 event.amount;
}
`;

const EVENTS = [
  { type: 'sale', amount: 10.00 },
  { type: 'sale', amount: 20.50 },
  { type: 'sale', amount: 0.50 },
];

function compileSrc(src) {
  return compile(check(parse(lex(src))));
}

test('acceptance 2: kill at crash point, recover matches no-crash reference', () => {
  const dir = mkTmp('je-crash-');
  const jeFile = writeFile(dir, 'batch.je', JE);
  const evFile = writeFile(dir, 'events.json', JSON.stringify(EVENTS));

  // Reference: full run with no crash.
  const refDb = path.join(dir, 'db-ref');
  const r0 = cli(['run', jeFile, evFile, '--db', refDb]);
  assert.equal(r0.status, 0, r0.error && r0.error.message);

  // Crash run: kill after the final POST (seq=3) is durable, before the
  // index update. crashMode 'throw' simulates the kill in-process (the
  // sandbox forbids child processes); the CLI exit path is covered by
  // RESULTS.md via `JE_CRASH_AT=post:3 je run ...`.
  const crashDb = path.join(dir, 'db-crash');
  const program = compileSrc(JE);
  const db = Db.open(crashDb, { crashAt: 3, crashMode: 'throw' });
  db.beginRun(program.periods);
  const err = captureThrow(() => vm.run(program, EVENTS, db));
  assert.ok(err, 'expected E_CRASH');
  assert.equal(err.code, 'E_CRASH');
  assert.match(err.message, /before index update/);

  // At the crash point: posting seq=3 is on disk, index only has seq=2.
  const postingsBefore = readLines(path.join(crashDb, 'postings.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(postingsBefore.map((p) => p.seq), [1, 2, 3]);
  const staleIndex = readJson(path.join(crashDb, 'index.json'));
  assert.equal(staleIndex.lastSeq, 2);
  assert.equal(staleIndex.batches['SALE#3'], 'IN_FLIGHT');

  // Recover: replays exactly seq=3, fixes the index.
  const r1 = cli(['recover', '--db', crashDb]);
  assert.equal(r1.status, 0, r1.error && r1.error.message);
  assert.match(r1.stdout, /REPLAYED posting seq=3/);
  assert.match(r1.stdout, /BATCH SALE#3 IN_FLIGHT/);

  const refIndex = readJson(path.join(refDb, 'index.json'));
  const gotIndex = readJson(path.join(crashDb, 'index.json'));
  // Ledger substance is identical to the no-crash reference.
  assert.deepEqual(gotIndex.balances, refIndex.balances);
  assert.equal(gotIndex.lastSeq, refIndex.lastSeq);
  assert.equal(
    fs.readFileSync(path.join(crashDb, 'postings.jsonl'), 'utf8'),
    fs.readFileSync(path.join(refDb, 'postings.jsonl'), 'utf8'),
  );
  // The killed batch stays IN_FLIGHT (never END_BATCHed) — not a failure,
  // and not silently marked POSTED.
  assert.deepEqual(gotIndex.batches, {
    'SALE#1': 'POSTED',
    'SALE#2': 'POSTED',
    'SALE#3': 'IN_FLIGHT',
  });
});

test('crash in the middle of a run: later batches simply never happened', () => {
  const dir = mkTmp('je-crash-mid-');
  const crashDb = path.join(dir, 'db');
  const program = compileSrc(JE);
  const db = Db.open(crashDb, { crashAt: 2, crashMode: 'throw' });
  db.beginRun(program.periods);
  const err = captureThrow(() => vm.run(program, EVENTS, db));
  assert.ok(err, 'expected E_CRASH');
  assert.equal(err.code, 'E_CRASH');

  const r = cli(['recover', '--db', crashDb]);
  assert.equal(r.status, 0, r.error && r.error.message);
  assert.match(r.stdout, /REPLAYED posting seq=2/);
  const index = readJson(path.join(crashDb, 'index.json'));
  assert.deepEqual(index.batches, { 'SALE#1': 'POSTED', 'SALE#2': 'IN_FLIGHT' });
  assert.equal(index.balances['1001'], 3050); // 10.00 + 20.50
  assert.equal(index.balances['2001'], -3050);
});
