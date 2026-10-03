import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkLedger, runCli, ok } from './helpers.js';
import { encodeBlock } from '../src/ledger.js';

test('recover drops a half-written block and stray tmp, then appends from last confirmed state', () => {
  const dir = mkLedger();
  ok(runCli(dir, ['freeze', '--amount', '30', '--key', 'a', '--quota', '1000']));
  ok(runCli(dir, ['capture', '--ticket', 'T000001', '--amount', '10', '--key', 'b']));
  ok(runCli(dir, ['release', '--ticket', 'T000001', '--amount', '5', '--key', 'c']));

  // Simulate a crash before fsync: full header, half of the payload.
  const half = encodeBlock({
    blockIndex: 4,
    seqStart: 4,
    events: [{ seq: 4, type: 'expire', ticketId: 'T000001' }],
    prevHash: 'unconfirmed',
  });
  const nl = half.indexOf(0x0a);
  const payloadLen = half.length - nl - 1;
  fs.writeFileSync(
    path.join(dir, 'blocks', '000004.blk'),
    half.subarray(0, nl + 1 + Math.floor(payloadLen / 2)),
  );
  fs.writeFileSync(path.join(dir, 'blocks', '000005.blk.tmp'), Buffer.from('partial'));

  // Normal commands refuse to run on a corrupted ledger (exit 2).
  assert.equal(runCli(dir, ['ticket', '--ticket', 'T000001']).code, 2);
  assert.equal(runCli(dir, ['freeze', '--amount', '1', '--key', 'z']).code, 2);

  const recovered = ok(runCli(dir, ['recover'])).result;
  assert.deepEqual(recovered.removedBlocks.sort(), ['000004.blk', '000005.blk.tmp']);
  assert.equal(recovered.lastBlock, 3);

  // State reflects only the confirmed blocks.
  const ticket = ok(runCli(dir, ['ticket', '--ticket', 'T000001'])).result;
  assert.deepEqual(
    [ticket.frozen, ticket.captured, ticket.released, ticket.status],
    [15, 10, 5, 'OPEN'],
  );

  // Appending continues at block 4 from the confirmed state.
  const frozen = ok(runCli(dir, ['freeze', '--amount', '20', '--key', 'd'])).result;
  assert.equal(frozen.available, 1000 - 15 - 10 - 20);
  assert.ok(fs.existsSync(path.join(dir, 'blocks', '000004.blk')));
});

test('recover truncates at a crc-bad block together with all followers', () => {
  const dir = mkLedger();
  ok(runCli(dir, ['freeze', '--amount', '40', '--key', 'a', '--quota', '100']));
  ok(runCli(dir, ['capture', '--ticket', 'T000001', '--amount', '10', '--key', 'b']));
  ok(runCli(dir, ['release', '--ticket', 'T000001', '--amount', '5', '--key', 'c']));
  ok(runCli(dir, ['expire', '--ticket', 'T000001', '--key', 'd']));

  // Corrupt one payload byte of block 2, keeping the length intact.
  const block2 = path.join(dir, 'blocks', '000002.blk');
  const buf = fs.readFileSync(block2);
  buf[buf.length - 1] ^= 0xff;
  fs.writeFileSync(block2, buf);

  const recovered = ok(runCli(dir, ['recover'])).result;
  assert.deepEqual(recovered.removedBlocks, ['000002.blk', '000003.blk', '000004.blk']);
  assert.equal(recovered.lastBlock, 1);

  // Only block 1 (the freeze) survives.
  const ticket = ok(runCli(dir, ['ticket', '--ticket', 'T000001'])).result;
  assert.deepEqual([ticket.status, ticket.frozen, ticket.captured], ['OPEN', 40, 0]);

  // Idempotency keys from removed blocks are forgotten; expire can be re-issued.
  ok(runCli(dir, ['expire', '--ticket', 'T000001', '--key', 'd']));
  const expired = ok(runCli(dir, ['ticket', '--ticket', 'T000001'])).result;
  assert.equal(expired.status, 'EXPIRED');
});

test('recover rebuilds index and snapshots from confirmed blocks', () => {
  const dir = mkLedger();
  ok(runCli(dir, ['freeze', '--amount', '50', '--key', 'a', '--quota', '500']));
  ok(runCli(dir, ['capture', '--ticket', 'T000001', '--amount', '20', '--key', 'b']));
  ok(runCli(dir, ['release', '--ticket', 'T000001', '--amount', '5', '--key', 'c']));
  ok(runCli(dir, ['freeze', '--amount', '10', '--key', 'd']));

  // A snapshot exists after 4 blocks and records the pre-snapshot state.
  assert.ok(fs.existsSync(path.join(dir, 'snapshots', '000004.snap')));

  fs.rmSync(path.join(dir, 'snapshots'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'index.json'), { force: true });

  const recovered = ok(runCli(dir, ['recover'])).result;
  assert.deepEqual(recovered.removedBlocks, []);
  assert.equal(recovered.lastBlock, 4);

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.tickets.T000001, 1);
  assert.equal(index.tickets.T000002, 4);

  const ticket = ok(runCli(dir, ['ticket', '--ticket', 'T000001'])).result;
  assert.deepEqual([ticket.frozen, ticket.captured, ticket.released], [25, 20, 5]);
});
