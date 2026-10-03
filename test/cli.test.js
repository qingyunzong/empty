import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'clearing.js');

// Note: this sandbox swallows piped stdout of nested node processes, so the
// child is driven through temp files instead of pipes.
function runCli(lines) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
    const inFile = path.join(dir, 'in.jsonl');
    const outPath = path.join(dir, 'out.jsonl');
    fs.writeFileSync(inFile, lines.join('\n') + '\n');
    const proc = spawn('bash', ['-c', `"${process.execPath}" "${CLI}" < "${inFile}" > "${outPath}"`]);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}`));
      const out = fs.readFileSync(outPath, 'utf8');
      resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    });
  });
}

test('JSONL CLI end-to-end flow with error lines', async () => {
  const res = await runCli([
    '{"cmd":"account","id":"A","funds":{"num":100,"den":1}}',
    '{"cmd":"account","id":"B","funds":0}',
    '{"cmd":"order","id":"o1","account":"A","symbol":"X","side":"buy","qty":2,"limit":{"num":5,"den":1}}',
    '{"cmd":"order","id":"o2","account":"B","symbol":"X","side":"sell","qty":2,"limit":{"num":3,"den":1}}',
    '{"cmd":"trial","window":"w1","prices":{"X":{"num":4,"den":1}}}',
    '{"cmd":"commit","id":"c1","trial":"t1"}',
    '{"cmd":"commit","id":"c1","trial":"t1"}',
    '{"cmd":"check","trial":"t1"}',
    '{"cmd":"compensate","id":"r1","commit":"c1"}',
    '{"cmd":"state"}',
    '{"cmd":"trial","window":"w2","prices":{"X":{"num":4,"den":0}}}',
    '{"cmd":"bogus"}',
    'not json',
  ]);
  assert.equal(res.length, 13);
  assert.ok(res.every((r, i) => (i >= 10 ? !r.ok : r.ok)), JSON.stringify(res));
  const trial = res[4].result;
  assert.equal(trial.result.qty, '2');
  assert.equal(trial.result.count, '1');
  assert.deepEqual(trial.reads.orders, { o1: 0, o2: 0 });
  assert.equal(res[5].result.status, 'committed');
  assert.equal(res[6].result.idempotent, true);
  assert.equal(res[7].result.ok, true);
  assert.equal(res[8].result.status, 'compensated');
  assert.equal(res[9].result.accounts.A.funds.num, '100'); // fully reversed
  assert.equal(res[10].error.code, 'E_PRICE');
  assert.equal(res[11].error.code, 'E_UNKNOWN_CMD');
  assert.ok(res[12].error.code);
});
