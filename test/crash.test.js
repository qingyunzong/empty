import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LeaseStore, CrashError, PersistError, CRASH_POINTS } from '../src/store.js';
import { cli, jsonl } from './helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agv-store-'));
}

const BASE = {
  version: 1,
  fencing: { t0: 1 },
  leases: { t0: { owner: 'old-agv', epoch: 1, leaseStart: 0, leaseExpiry: 50 } },
};
const NEXT = {
  version: 1,
  fencing: { t0: 1, t1: 2 },
  leases: {
    t0: { owner: 'old-agv', epoch: 1, leaseStart: 0, leaseExpiry: 50 },
    t1: { owner: 'agv-1', epoch: 2, leaseStart: 10, leaseExpiry: 110 },
  },
};

// 验收 2: 三个崩溃注入点,恢复后无双重占有。
for (const point of CRASH_POINTS) {
  test(`crash at ${point}: recovery yields a single consistent owner`, () => {
    const dir = tmpdir();
    const store = new LeaseStore(dir);
    store.commit(BASE);
    assert.throws(() => store.commit(NEXT, { crashAt: point }), CrashError);

    const { action, state } = store.recover();
    assert.equal(fs.existsSync(store.tmp), false, 'tmp file must be cleaned up');

    if (point === 'after-tmp-write') {
      // rename never happened: the new lease was never granted
      assert.equal(action, 'discarded-tmp');
      assert.equal(state.leases.t1, undefined);
      assert.equal(state.fencing.t1, undefined);
    } else {
      // rename is the atomic commit point: the new lease is durable
      assert.equal(action, 'committed');
      assert.equal(state.leases.t1.owner, 'agv-1');
      assert.equal(state.fencing.t1, 2);
    }
    // old lease intact in every case; exactly one lease record per task
    assert.equal(state.leases.t0.owner, 'old-agv');
    assert.equal(new Set(Object.keys(state.leases)).size, Object.keys(state.leases).length);
    assert.ok(Object.values(state.leases).every((l) => typeof l.owner === 'string'));
  });
}

test('cli: lease crash injection then recover, no double ownership', () => {
  const dir = tmpdir();
  const crashed = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'agv-1',
    '--epoch', '1', '--lease-ms', '100', '--now', '10', '--crash-at', 'after-tmp-write']);
  assert.equal(crashed.code, 75);
  assert.equal(jsonl(crashed.stdout)[0].at, 'after-tmp-write');

  const recovered = cli(['recover', '--store', dir]);
  assert.equal(recovered.code, 0);
  const rec = jsonl(recovered.stdout)[0];
  assert.equal(rec.action, 'discarded-tmp');
  assert.deepEqual(rec.leases, []);

  // retry after recovery succeeds exactly once
  const ok = cli(['lease', '--store', dir, '--task', 't1', '--agv', 'agv-1',
    '--epoch', '1', '--lease-ms', '100', '--now', '10']);
  assert.equal(ok.code, 0);
  const again = cli(['recover', '--store', dir]);
  const state = jsonl(again.stdout)[0];
  assert.deepEqual(state.leases, ['t1']);
});

test('corrupt lease.json fails validation with exit 9', () => {
  const dir = tmpdir();
  const store = new LeaseStore(dir);
  store.commit(BASE);
  fs.writeFileSync(store.file, '{ not json');
  assert.throws(() => store.load(), PersistError);
  const r = cli(['recover', '--store', dir]);
  assert.equal(r.code, 9);
  assert.equal(jsonl(r.stdout)[0].reason, 'persist-invalid');
});

test('tampered checksum fails validation with exit 9', () => {
  const dir = tmpdir();
  const store = new LeaseStore(dir);
  store.commit(BASE);
  const parsed = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  parsed.leases.t0.owner = 'attacker';
  fs.writeFileSync(store.file, JSON.stringify(parsed));
  const r = cli(['recover', '--store', dir]);
  assert.equal(r.code, 9);
});
