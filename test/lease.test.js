import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replay } from '../src/scheduler.js';
import { cli, jsonl, join, claim } from './helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agv-lease-'));
}

// 验收 3: 成员隔离后,旧租约到期才可接管。
test('quarantined member: lease must expire before takeover; history preserved', () => {
  const s = replay([
    join('agv-1'), join('agv-2'),
    claim('t1', 'agv-1', 1, 0, 100, { s: 1 }),
    { type: 'quarantine', agv: 'agv-1', time: 10 },
    claim('t1', 'agv-2', 2, 50, 100, { s: 2 }),
    claim('t2', 'agv-1', 2, 60, 100, { s: 3 }),
    claim('t1', 'agv-2', 2, 101, 100, { s: 4 }),
  ]);
  const d = s.decisions.filter((x) => x.event === 'claim');
  assert.equal(d[1].result, 'rejected');
  assert.equal(d[1].reason, 'held', 'lease not expired yet: takeover refused');
  assert.equal(d[2].result, 'rejected');
  assert.equal(d[2].reason, 'quarantined', 'quarantine blocks new tasks');
  assert.equal(d[3].result, 'takeover', 'lease expired: takeover allowed');

  const t1 = s.tasks.get('t1');
  assert.equal(t1.owner, 'agv-2');
  assert.equal(t1.fencingEpoch, 2);
  assert.equal(
    t1.history.some((h) => h.agv === 'agv-1' && h.result === 'granted'),
    true,
    'quarantine does not delete history',
  );
});

test('takeover before expiry is rejected even with a higher epoch', () => {
  const s = replay([
    join('agv-1'), join('agv-2'),
    claim('t1', 'agv-1', 1, 0, 1000, { s: 1 }),
    { type: 'quarantine', agv: 'agv-1', time: 10 },
    claim('t1', 'agv-2', 9, 500, 1000, { s: 2 }),
  ]);
  const d = s.decisions.at(-1);
  assert.equal(d.result, 'rejected');
  assert.equal(d.reason, 'held');
});

test('leave releases tasks into the takeover set immediately', () => {
  const s = replay([
    join('agv-1'), join('agv-2'),
    claim('t1', 'agv-1', 1, 0, 1000, { s: 1 }),
    { type: 'leave', agv: 'agv-1', time: 10 },
    claim('t1', 'agv-2', 2, 20, 1000, { s: 2 }),
  ]);
  const d = s.decisions.at(-1);
  assert.equal(d.result, 'takeover');
  assert.equal(s.tasks.get('t1').owner, 'agv-2');
});

// 错误码: 低代次 claim -> exit 8。
test('cli lease: stale epoch exits 8, higher epoch succeeds', () => {
  const dir = tmpdir();
  const grant = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a1',
    '--epoch', '2', '--lease-ms', '100', '--now', '0']);
  assert.equal(grant.code, 0);
  assert.equal(jsonl(grant.stdout)[0].granted, true);

  const stale = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a2',
    '--epoch', '1', '--lease-ms', '100', '--now', '200']);
  assert.equal(stale.code, 8);
  assert.equal(jsonl(stale.stdout)[0].reason, 'stale-epoch');

  const equalEpochOther = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a2',
    '--epoch', '2', '--lease-ms', '100', '--now', '200']);
  assert.equal(equalEpochOther.code, 8);

  const takeover = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a2',
    '--epoch', '3', '--lease-ms', '100', '--now', '200']);
  assert.equal(takeover.code, 0);
});

test('cli lease: live lease held by another agv exits 1', () => {
  const dir = tmpdir();
  cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a1',
    '--epoch', '1', '--lease-ms', '1000', '--now', '0']);
  const held = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a2',
    '--epoch', '2', '--lease-ms', '1000', '--now', '10']);
  assert.equal(held.code, 1);
  assert.equal(jsonl(held.stdout)[0].reason, 'held');
});

test('cli lease: owner renews with same epoch, stale renew exits 8', () => {
  const dir = tmpdir();
  cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a1',
    '--epoch', '2', '--lease-ms', '100', '--now', '0']);
  const renew = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a1',
    '--epoch', '2', '--lease-ms', '100', '--now', '50']);
  assert.equal(renew.code, 0);
  assert.equal(jsonl(renew.stdout)[0].result, 'renewed');
  const stale = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a1',
    '--epoch', '1', '--lease-ms', '100', '--now', '60']);
  assert.equal(stale.code, 8);
});

test('cli lease: corrupt store exits 9', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lease.json'), 'garbage');
  const r = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'a1', '--epoch', '1']);
  assert.equal(r.code, 9);
});
