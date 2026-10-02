import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, runCli, tmpStore, readState } from './helpers.js';
import { makeEvent } from '../src/event.js';

function apply(store, event) {
  return runCli(['apply', '--store', store, '--event', JSON.stringify(event)]);
}

test('未知因果进 pending，前因到达后自动生效', () => {
  const tablet = tmpStore('alarm-t');
  const server = tmpStore('alarm-s');
  const create = emit(tablet, 'T1', 'create', 'WO-1').stdout.event;
  const raise = emit(tablet, 'T1', 'raise', 'WO-1', ['--data', '{"alarm":"A1"}']).stdout.event;
  const clear = emit(tablet, 'T1', 'clear', 'WO-1', ['--data', '{"alarm":"A1"}']).stdout.event;

  // 服务器先收到 clear（缺少因果前因）-> pending，退出码 9
  let r = apply(server, clear);
  assert.equal(r.code, 9);
  assert.equal(r.stdout.status, 'pending');
  assert.equal(readState(server).orders['WO-1'], undefined);

  // 前因补齐后自动生效，无需重投 clear
  assert.equal(apply(server, create).code, 0);
  assert.equal(apply(server, raise).code, 0);
  const o = readState(server).orders['WO-1'];
  assert.equal(o.alarms['A1'].raised, false);
  assert.equal(o.alarms['A1'].clearedBy, clear.id);
});

test('clear 不晚于 raise（并发）则无效，被拒绝', () => {
  const tablet = tmpStore('alarm-t2');
  const server = tmpStore('alarm-s2');
  const create = emit(tablet, 'T1', 'create', 'WO-2').stdout.event;
  const raise = emit(tablet, 'T1', 'raise', 'WO-2', ['--data', '{"alarm":"A1"}']).stdout.event;
  assert.equal(apply(server, create).code, 0);
  assert.equal(apply(server, raise).code, 0);

  // 另一站点并发发出 clear（其向量时钟不包含 raise）-> clear-before-raise，退出码 3
  const badClear = makeEvent({
    site: 'T9', seq: 1, clock: { T1: 1 }, type: 'clear', order: 'WO-2',
    data: { alarm: 'A1' }, actor: 'ops', ts: Date.now(),
  });
  const r = apply(server, badClear);
  assert.equal(r.code, 3);
  assert.equal(r.stdout.status, 'rejected');
  assert.equal(r.stdout.reason, 'clear-before-raise');
  assert.equal(readState(server).orders['WO-2'].alarms['A1'].raised, true);
});

test('clear 引用完全未知的报警 -> pending(raise-unknown)', () => {
  const tablet = tmpStore('alarm-t3');
  const server = tmpStore('alarm-s3');
  const create = emit(tablet, 'T1', 'create', 'WO-3').stdout.event;
  assert.equal(apply(server, create).code, 0);
  const clear = makeEvent({
    site: 'T9', seq: 1, clock: { T1: 1 }, type: 'clear', order: 'WO-3',
    data: { alarm: 'A9' }, actor: 'ops', ts: Date.now(),
  });
  const r = apply(server, clear);
  assert.equal(r.code, 9);
  assert.equal(r.stdout.status, 'pending');
  assert.equal(r.stdout.reason, 'raise-unknown');
});
