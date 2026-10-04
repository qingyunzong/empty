import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/store.js';
import { Ledger } from '../src/ledger.js';

const CMDS = [
  { op: 'open_account', accountId: 'acct', creditLimit: 1000 },
  { op: 'authorize', accountId: 'acct', authId: 'A1', amount: 400, requestId: 'r1' },
  { op: 'capture', accountId: 'acct', authId: 'A1', amount: 150, merchantId: 'm1', requestId: 'r2' },
  { op: 'reverse', accountId: 'acct', authId: 'A1', requestId: 'r3' },
];

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'events.jsonl');
}

test('crash before fsync with torn tail: recovery truncates and preserves synced events', () => {
  const logPath = tmpLog();
  const log = new EventLog(logPath);
  log.open();
  // first three commands are written and fsynced
  for (const cmd of CMDS.slice(0, 3)) log.append({ cmd });
  // simulate a crash mid-write of the 4th record: partial bytes, no newline,
  // never fsynced
  const partial = JSON.stringify({ cmd: CMDS[3] }).slice(0, 20);
  fs.writeSync(log.fd, partial);
  log.close();

  const info = EventLog.recover(logPath);
  assert.equal(info.repaired, true);
  assert.ok(info.truncatedBytes > 0);
  assert.equal(info.events.length, 3);
  // file was repaired in place: no leftover torn bytes
  assert.equal(fs.statSync(logPath).size, fs.readFileSync(logPath).length);
  const raw = fs.readFileSync(logPath, 'utf8');
  assert.ok(raw.endsWith('\n'));

  // recovered state equals deterministic replay of the surviving prefix
  const recovered = Ledger.replay(info.events.map((e) => e.cmd));
  const expected = Ledger.replay(CMDS, 3);
  assert.deepEqual(recovered.snapshot(), expected.snapshot());
  assert.equal(recovered.available('acct'), 600); // 1000 - 250 held - 150 posted

  // log stays appendable after repair
  const log2 = new EventLog(logPath);
  log2.open();
  log2.append({ cmd: CMDS[3] });
  log2.close();
  const info2 = EventLog.recover(logPath);
  assert.equal(info2.repaired, false);
  assert.equal(info2.events.length, 4);
  const final = Ledger.replay(info2.events.map((e) => e.cmd));
  assert.equal(final.available('acct'), 850); // reverse freed the remaining 250
});

test('complete lines written without fsync still recover (data reached the file)', () => {
  const logPath = tmpLog();
  const log = new EventLog(logPath);
  log.open();
  log.append({ cmd: CMDS[0] });
  log.append({ cmd: CMDS[1] }, { sync: false }); // buffered, not fsynced
  log.close(); // close flushes to the OS; recovery sees both lines
  const info = EventLog.recover(logPath);
  assert.equal(info.repaired, false);
  assert.equal(info.events.length, 2);
});

test('invalid JSON mid-log truncates everything after it', () => {
  const logPath = tmpLog();
  const log = new EventLog(logPath);
  log.open();
  log.append({ cmd: CMDS[0] });
  log.close();
  fs.appendFileSync(logPath, '{"cmd": garbage\n');
  fs.appendFileSync(logPath, JSON.stringify({ cmd: CMDS[1] }) + '\n');
  const info = EventLog.recover(logPath);
  assert.equal(info.repaired, true);
  assert.equal(info.events.length, 1);
});

test('missing log recovers to empty', () => {
  const info = EventLog.recover(path.join(os.tmpdir(), 'definitely-missing-ledger.jsonl'));
  assert.deepEqual(info, { events: [], repaired: false, truncatedBytes: 0 });
});
