import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, runCli, tmpStore, readState, readLogEvents } from './helpers.js';

test('重复投递：同一事件重复 apply 不重复生效', () => {
  const a = tmpStore('dedup-a');
  const b = tmpStore('dedup-b');
  const created = emit(a, 'T1', 'create', 'WO-1');
  const ev = created.stdout.event;
  // 同一事件重复投递 3 次
  for (let i = 0; i < 3; i++) {
    const r = runCli(['apply', '--store', b, '--event', JSON.stringify(ev)]);
    assert.equal(r.code, 0);
    if (i > 0) assert.equal(r.stdout.duplicate, true);
  }
  assert.equal(readLogEvents(b).length, 1);
  assert.equal(readState(b).orders['WO-1'].status, 'created');
  // 重复 sync 幂等
  assert.equal(runCli(['sync', '--store', a, '--peer', b]).code, 0);
  const again = runCli(['sync', '--store', a, '--peer', b]);
  assert.equal(again.code, 0);
  assert.equal(again.stdout.transferred, 0);
  assert.equal(readLogEvents(a).length, 1);
  assert.equal(readLogEvents(b).length, 1);
});

test('篡改事件 hash 被拒绝（退出码 2）', () => {
  const a = tmpStore('tamper-a');
  const b = tmpStore('tamper-b');
  const ev = emit(a, 'T1', 'create', 'WO-9').stdout.event;
  const bad = { ...ev, data: { team: 'evil' } };
  const r = runCli(['apply', '--store', b, '--event', JSON.stringify(bad)]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr.error.kind, 'bad-event');
});
