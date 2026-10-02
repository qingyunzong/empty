import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
}

function run(dir, ...args) {
  // capture via file redirect: pipe capture of grandchild stdout is unreliable
  // in some sandboxed environments
  const outFile = path.join(dir, '.cli-out');
  const fd = fs.openSync(outFile, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const text = fs.readFileSync(outFile, 'utf8').trim();
  fs.rmSync(outFile, { force: true });
  return { code: r.status, out: text ? JSON.parse(text) : null };
}

test('cli end-to-end: events, idempotency, errors, savepoint, rollback, recover', () => {
  const dir = tmp();

  let r = run(dir, 'receive', '--batch', 'P', '--material', 'M', '--qty', '100', '--key', 'k1');
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);

  // duplicate key: same result, exit 0, no stock change
  r = run(dir, 'receive', '--batch', 'P', '--material', 'M', '--qty', '100', '--key', 'k1');
  assert.equal(r.code, 0);
  assert.equal(r.out.duplicate, true);
  r = run(dir, 'balances');
  assert.equal(r.out.balances[0].available, 100);

  // over-stock issue -> E_STOCK, exit 1
  r = run(dir, 'issue', '--batch', 'P', '--qty', '500', '--key', 'k2');
  assert.equal(r.code, 1);
  assert.equal(r.out.code, 'E_STOCK');

  // reservation budget enforced via CLI
  run(dir, 'reserve', '--batch', 'P', '--qty', '30', '--key', 'r1');
  r = run(dir, 'issue', '--batch', 'P', '--qty', '40', '--key', 'k3');
  assert.equal(r.out.code, 'E_STOCK');
  r = run(dir, 'issue', '--batch', 'P', '--qty', '30', '--key', 'k4');
  assert.equal(r.code, 0);

  // savepoint + rollback
  r = run(dir, 'savepoint', '--name', 's1');
  assert.equal(r.code, 0);
  run(dir, 'receive', '--batch', 'P', '--material', 'M', '--qty', '50', '--key', 'k5');
  r = run(dir, 'rollback', '--to', 's1');
  assert.equal(r.code, 0);
  assert.equal(r.out.certificate.count, 1);
  r = run(dir, 'balances');
  assert.equal(r.out.balances[0].received, 100);

  // rollback to unknown savepoint -> E_SAVEPOINT, exit 1
  r = run(dir, 'rollback', '--to', 'ghost');
  assert.equal(r.code, 1);
  assert.equal(r.out.code, 'E_SAVEPOINT');

  // corrupt the log tail -> E_CRC exit 2, then recover
  const logPath = path.join(dir, 'events.log');
  const size = fs.statSync(logPath).size;
  const fd = fs.openSync(logPath, 'r+');
  fs.writeSync(fd, Buffer.from([0x00, 0x01, 0x02]), 0, 3, size - 6);
  fs.closeSync(fd);
  r = run(dir, 'balances');
  assert.equal(r.code, 2);
  assert.equal(r.out.code, 'E_CRC');
  r = run(dir, 'recover');
  assert.equal(r.code, 0);
  assert.equal(r.out.recovered, true);
  r = run(dir, 'balances');
  assert.equal(r.code, 0);
});
