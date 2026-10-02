import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/micro.js', import.meta.url));

export function cli(args, cwd) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function dir() {
  return mkdtempSync(join(tmpdir(), 'micro-'));
}

test('通道冲突 exit 10 并输出冲突解释', () => {
  const d = dir();
  const r2 = cli(['book', 'b1', '--group', 'g', '--objective', '20x', '--channels', 'GFP,RFP', '--fields', '3'], d);
  assert.equal(r2.code, 10);
  const explain = JSON.parse(r2.err);
  assert.equal(explain.error, 'CHANNEL_CONFLICT');
  assert.deepEqual(explain.details.pair, ['GFP', 'RFP']);
  rmSync(d, { recursive: true, force: true });
});

test('维护重叠 exit 10', () => {
  const d = dir();
  assert.equal(cli(['maintain', '--start', '4', '--end', '8'], d).code, 0);
  const r = cli(['maintain', '--start', '6', '--end', '10'], d);
  assert.equal(r.code, 10);
  assert.equal(JSON.parse(r.err).error, 'MAINTENANCE_OVERLAP');
  rmSync(d, { recursive: true, force: true });
});

test('负视野 exit 10', () => {
  const d = dir();
  const r = cli(['book', 'b1', '--group', 'g', '--objective', '20x', '--channels', 'DAPI', '--fields', '-3'], d);
  assert.equal(r.code, 10);
  assert.equal(JSON.parse(r.err).error, 'NEGATIVE_FIELDS');
  assert.equal(cli(['book', 'b1', '--group', 'g', '--objective', '20x', '--channels', 'DAPI', '--fields', '3'], d).code, 0);
  const r2 = cli(['correct', 'b1', '--delta', '-5'], d);
  assert.equal(r2.code, 10);
  rmSync(d, { recursive: true, force: true });
});

test('未知批次 exit 1', () => {
  const d = dir();
  const r = cli(['cancel', 'nope'], d);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.err).error, 'UNKNOWN_BATCH');
  rmSync(d, { recursive: true, force: true });
});
