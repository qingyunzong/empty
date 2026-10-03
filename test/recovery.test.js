import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../testkit/helpers.js';
import { execute, loadState } from '../src/store.js';
import { HEADER_LEN, encodeChunk, verifyChain } from '../src/chunklog.js';

function buildLog(dir) {
  execute(dir, 'freeze', { amount: 100, key: 'a' }, {}); // chunk 1 -> T-000001
  execute(dir, 'freeze', { amount: 200, key: 'b' }, {}); // chunk 2 -> T-000002
  execute(dir, 'capture', { ticket: 'T-000001', amount: 40, key: 'c' }, {}); // chunk 3
  execute(dir, 'release', { ticket: 'T-000002', amount: 50, key: 'd' }, {}); // chunk 4 (snapshot)
  execute(dir, 'capture', { ticket: 'T-000002', amount: 50, key: 'e' }, {}); // chunk 5
  execute(dir, 'freeze', { amount: 60, key: 'f' }, {}); // chunk 6 -> T-000003
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fzrec-'));
}

test('half-written chunk (crash before fsync) is deleted by recover; appends continue', () => {
  const dir = tmpdir();
  buildLog(dir);
  assert.equal(verifyChain(dir).tip.seqEnd, 6);

  // Simulate a crash before fsync: a truncated chunk file is left behind.
  const tip = verifyChain(dir).tip;
  const ghost = encodeChunk({
    seqStart: 7,
    seqEnd: 7,
    prevHash: tip.hash,
    events: [{ type: 'capture', command: 'capture', ticketId: 'T-000002', amount: 10 }],
  });
  fs.writeFileSync(path.join(dir, 'chunks', 'chunk-000007.chk'), ghost.subarray(0, HEADER_LEN + 5));

  // Normal commands refuse to run on a corrupt log with exit code 2.
  const denied = runCli(['capture', '--ticket', 'T-000002', '--amount', '10'], { dir });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /corruption/);

  const rec = runCli(['recover'], { dir });
  assert.equal(rec.status, 0);
  assert.deepEqual(rec.json.removedChunks, ['chunk-000007.chk']);
  assert.equal(rec.json.confirmedSeqEnd, 6);
  assert.ok(!fs.existsSync(path.join(dir, 'chunks', 'chunk-000007.chk')), 'half chunk deleted');

  // Last confirmed state is intact and the log can be appended again.
  const t = runCli(['ticket', '--ticket', 'T-000002'], { dir });
  assert.equal(t.status, 0);
  assert.equal(t.json.ticket.captured, 50);
  assert.equal(t.json.ticket.released, 50);
  const next = runCli(['capture', '--ticket', 'T-000002', '--amount', '10'], { dir });
  assert.equal(next.status, 0);
  assert.equal(verifyChain(dir).tip.seqEnd, 7);
  assert.ok(verifyChain(dir).ok);
});

test('crc-corrupt chunk invalidates itself and later chunks; recover trims to boundary', () => {
  const dir = tmpdir();
  buildLog(dir);
  const snapBefore = path.join(dir, 'snapshots', 'snap-000004.json');
  assert.ok(fs.existsSync(snapBefore), 'snapshot exists at chunk 4');

  // Flip a payload byte inside chunk 3: length stays valid, CRC breaks.
  const victim = path.join(dir, 'chunks', 'chunk-000003.chk');
  const buf = fs.readFileSync(victim);
  buf[HEADER_LEN + 1] ^= 0xFF;
  fs.writeFileSync(victim, buf);

  const denied = runCli(['ticket', '--ticket', 'T-000001'], { dir });
  assert.equal(denied.status, 2);

  const rec = runCli(['recover'], { dir });
  assert.equal(rec.status, 0);
  assert.deepEqual(rec.json.removedChunks, [
    'chunk-000003.chk',
    'chunk-000004.chk',
    'chunk-000005.chk',
    'chunk-000006.chk',
  ]);
  assert.equal(rec.json.confirmedSeqEnd, 2);
  assert.deepEqual(rec.json.removedSnapshots, ['snap-000004.json']);
  assert.ok(!fs.existsSync(snapBefore), 'stale snapshot beyond boundary removed');

  // State reflects exactly the first two events.
  const { state } = loadState(dir);
  assert.equal(state.lastSeq, 2);
  assert.equal(state.tickets['T-000001'].captured, 0);
  assert.equal(state.tickets['T-000002'].released, 0);
  assert.equal(state.tickets['T-000003'], undefined);

  // Index rebuilt: ticket from chunk 1 still decodes through the index path.
  const t = runCli(['ticket', '--ticket', 'T-000001'], { dir });
  assert.equal(t.status, 0);
  assert.equal(t.json.indexChunk, 'chunk-000001.chk');
  assert.equal(t.json.ticket.remaining, 100);

  // Appends continue from the confirmed boundary with a proper hash chain.
  const next = runCli(['capture', '--ticket', 'T-000001', '--amount', '40'], { dir });
  assert.equal(next.status, 0);
  const chain = verifyChain(dir);
  assert.ok(chain.ok);
  assert.equal(chain.tip.seqEnd, 3);
  assert.equal(chain.chunks[2].seqStart, 3);
  assert.equal(chain.chunks[2].prevHash, chain.chunks[1].hash);
});

test('recover on a healthy log is a no-op', () => {
  const dir = tmpdir();
  buildLog(dir);
  const rec = runCli(['recover'], { dir });
  assert.equal(rec.status, 0);
  assert.equal(rec.json.healthy, true);
  assert.deepEqual(rec.json.removedChunks, []);
  assert.equal(rec.json.confirmedSeqEnd, 6);
  assert.equal(verifyChain(dir).tip.seqEnd, 6);
});
