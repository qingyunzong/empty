'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp, readJson, readLines, cli } = require('../testsupport/helpers');
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

function crashedDb(dir, crashAt) {
  const program = compile(check(parse(lex(JE))));
  const db = Db.open(dir, { crashAt, crashMode: 'throw' });
  db.beginRun(program.periods);
  try {
    vm.run(program, EVENTS, db);
  } catch (err) {
    if (err.code !== 'E_CRASH') throw err;
  }
}

function snapshot(dir) {
  const out = {};
  for (const f of ['wal.log', 'postings.jsonl', 'index.json']) {
    out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return out;
}

test('acceptance 3: repeated recover is idempotent', () => {
  const dir = mkTmp('je-idem-');
  const db = path.join(dir, 'db');
  crashedDb(db, 3);

  const r1 = cli(['recover', '--db', db]);
  assert.equal(r1.status, 0, r1.error && r1.error.message);
  assert.match(r1.stdout, /replayed 1 posting/);
  const snap1 = snapshot(db);

  const r2 = cli(['recover', '--db', db]);
  assert.equal(r2.status, 0, r2.error && r2.error.message);
  assert.match(r2.stdout, /replayed 0 posting/);
  assert.deepEqual(snapshot(db), snap1);

  const r3 = cli(['recover', '--db', db]);
  assert.equal(r3.status, 0);
  assert.deepEqual(snapshot(db), snap1);
});

test('no double posting and no missing posting after recover', () => {
  const dir = mkTmp('je-once-');
  const db = path.join(dir, 'db');
  crashedDb(db, 2); // crash mid-run: seq=2 durable, index has seq=1
  cli(['recover', '--db', db]);
  const index = readJson(path.join(db, 'index.json'));
  const postings = readLines(path.join(db, 'postings.jsonl')).map((l) => JSON.parse(l));
  // every durable posting applied exactly once
  let cash = 0;
  for (const p of postings) {
    for (const leg of p.legs) {
      if (leg.account === '1001') cash += leg.side === 'dr' ? leg.amount : -leg.amount;
    }
  }
  assert.equal(index.balances['1001'], cash);
  assert.equal(index.lastSeq, postings.length);
});

test('E_REPLAY: posting on disk without a matching WAL record', () => {
  const dir = mkTmp('je-replay-');
  const db = path.join(dir, 'db');
  crashedDb(db, 3);
  cli(['recover', '--db', db]);
  // Corrupt: append a posting the WAL never saw.
  fs.appendFileSync(
    path.join(db, 'postings.jsonl'),
    JSON.stringify({ seq: 4, batch: 'SALE#3', legs: [{ side: 'dr', account: '1001', amount: 1 }, { side: 'cr', account: '2001', amount: 1 }] }) + '\n',
  );
  const r = cli(['recover', '--db', db]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_REPLAY');
  assert.match(r.error.message, /no matching WAL POST/);
});

test('E_REPLAY: posting content diverges from WAL record', () => {
  const dir = mkTmp('je-replay2-');
  const db = path.join(dir, 'db');
  crashedDb(db, 3);
  cli(['recover', '--db', db]);
  const p = path.join(db, 'postings.jsonl');
  const lines = readLines(p).map((l) => JSON.parse(l));
  lines[2].legs[0].amount = 999; // tamper with seq=3
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = cli(['recover', '--db', db]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_REPLAY');
  assert.match(r.error.message, /does not match its WAL record/);
});
