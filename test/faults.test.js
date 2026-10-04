import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, cli, addLot, addEvent } from '../testkit/helpers.js';

const CRASH = 70;

function manifestEntries(dir) {
  const file = path.join(dir, 'manifest.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function seed(dir) {
  assert.equal(addLot(dir, 'f1', 'A', 100, 1).code, 0);
  assert.equal(addLot(dir, 'f1', 'B', 50, 1).code, 0);
}

test('fault: edge log crash before fsync leaves no half edge', () => {
  const dir = tmpdir();
  seed(dir);
  const crashed = cli(['add', '--dir', dir, '--site', 'f1', '--op', 'merge', '--in', 'A:60,B:50', '--out', 'C:110', '--ts', '2'], { env: { LOT_FAULT: 'edge-pre-fsync', LOT_FAULT_TEAR: '1' } });
  assert.equal(crashed.code, CRASH);

  const resumed = cli(['resume', '--dir', dir]);
  assert.equal(resumed.code, 0, resumed.stderr);
  const state = resumed.json();
  assert.equal(state.events, 0); // torn event truncated away, not half-applied
  assert.equal(state.lots, 2);

  // log is clean: subsequent writes append after the valid prefix
  const ok = addEvent(dir, 'f1', 'merge', [['A', 60], ['B', 50]], [['C', 110]], 2);
  assert.equal(ok.code, 0, ok.stderr);
  const again = cli(['resume', '--dir', dir]);
  assert.equal(again.json().events, 1);
});

test('fault: edge log crash after fsync recovers the durable edge exactly once', () => {
  const dir = tmpdir();
  seed(dir);
  const crashed = cli(['add', '--dir', dir, '--site', 'f1', '--op', 'merge', '--in', 'A:60,B:50', '--out', 'C:110', '--ts', '2'], { env: { LOT_FAULT: 'edge-post-fsync' } });
  assert.equal(crashed.code, CRASH);

  const resumed = cli(['resume', '--dir', dir]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.json().events, 1); // durable edge survived
  assert.equal(resumed.json().lots, 3);

  // re-opening keeps exactly one event: no duplicate replay
  const again = cli(['resume', '--dir', dir]);
  assert.equal(again.json().events, 1);
});

test('fault: snapshot crash before rename keeps old snapshot and replays log', () => {
  const dir = tmpdir();
  seed(dir);
  assert.equal(addEvent(dir, 'f1', 'merge', [['A', 60], ['B', 50]], [['C', 110]], 2).code, 0);
  assert.equal(cli(['resume', '--dir', dir]).code, 0); // first snapshot committed
  const snapBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

  assert.equal(addEvent(dir, 'f1', 'split', [['C', 110]], [['D', 70], ['E', 40]], 3).code, 0);
  const crashed = cli(['resume', '--dir', dir], { env: { LOT_FAULT: 'snapshot-pre-rename' } });
  assert.equal(crashed.code, CRASH);

  // old snapshot untouched, tmp cleaned on recovery, log replay restores everything
  assert.equal(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'), snapBefore);
  const resumed = cli(['resume', '--dir', dir]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.json().events, 2);
  assert.equal(resumed.json().lots, 5);
  assert.ok(!fs.existsSync(path.join(dir, 'snapshot.json.tmp')));
});

test('fault: cert manifest crash after commit never yields a double certificate', () => {
  const dir = tmpdir();
  seed(dir);
  assert.equal(addEvent(dir, 'f1', 'merge', [['A', 60], ['B', 50]], [['C', 110]], 2).code, 0);

  const crashed = cli(['prove', '--dir', dir, '--lot', 'C', '--out', path.join(dir, 'c1.json')], { env: { LOT_FAULT: 'cert-post-commit' } });
  assert.equal(crashed.code, CRASH);
  assert.equal(manifestEntries(dir).length, 1); // commit was durable

  // retry after crash: same cert id, no double commit
  const retried = cli(['prove', '--dir', dir, '--lot', 'C', '--out', path.join(dir, 'c2.json')]);
  assert.equal(retried.code, 0, retried.stderr);
  const entries = manifestEntries(dir);
  assert.equal(entries.length, 1);
  const certs = fs.readdirSync(path.join(dir, 'certs'));
  assert.equal(certs.length, 1);
  const c2 = JSON.parse(fs.readFileSync(path.join(dir, 'c2.json'), 'utf8'));
  assert.equal(entries[0].entry.certId, c2.certId); // retry reproduced the same cert

  // manifest hash chain is intact
  const verified = cli(['verify', '--dir', dir, '--cert', path.join(dir, 'c2.json')]);
  assert.equal(verified.code, 0, verified.stderr);
});
