import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolingSystem } from '../src/system.js';
import { makeMold, maintEvents, orderEvents } from '../testlib/helpers.js';

function setup(molds) {
  const sys = new ToolingSystem();
  for (const m of molds) sys.command({ cmd: 'addMold', ...m });
  return sys;
}

test('自动选模：保养次数最少优先', () => {
  const sys = setup([
    makeMold({ id: 'M1', usedMinutes: 0 }),
    makeMold({ id: 'M2', usedMinutes: 90 }),
  ]);
  const r = sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 50 });
  assert.equal(r.moldId, 'M1'); // M2 需要 1 次保养，M1 不需要
  assert.equal(r.maintenances.length, 0);
});

test('自动选模：并列时取最早完成（而非模具ID）', () => {
  const sys = setup([
    makeMold({ id: 'M1', calendar: [{ start: 500, end: 100000 }] }),
    makeMold({ id: 'M2', calendar: [{ start: 0, end: 100000 }] }),
  ]);
  const r = sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 50 });
  assert.equal(r.moldId, 'M2'); // M2 完成于 50，早于 M1 的 550
  assert.equal(r.end, 50);
});

test('自动选模：保养数与完成时间都并列时取模具ID升序', () => {
  const sys = setup([makeMold({ id: 'M2' }), makeMold({ id: 'M1' })]);
  const r = sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 50 });
  assert.equal(r.moldId, 'M1');
});

test('移动工单到指定模具，撤销后回到原模具原位置', () => {
  const sys = setup([makeMold({ id: 'M1' }), makeMold({ id: 'M2' })]);
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30, moldId: 'M1' });
  sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 30, moldId: 'M1' });
  const mv = sys.command({ cmd: 'move', orderId: 'O2', moldId: 'M2' });
  assert.equal(mv.moldId, 'M2');
  assert.deepEqual(sys.state.molds.M1.queue, ['O1']);
  assert.deepEqual(sys.state.molds.M2.queue, ['O2']);
  sys.command({ cmd: 'undo', txId: mv.txId });
  assert.deepEqual(sys.state.molds.M1.queue, ['O1', 'O2']);
  assert.deepEqual(sys.state.molds.M2.queue, []);
  assert.equal(sys.state.orders.O2.moldId, 'M1');
});

test('自动移动选择调整最少的模具', () => {
  const sys = setup([
    makeMold({ id: 'M1', usedMinutes: 0 }),
    makeMold({ id: 'M2', usedMinutes: 90 }),
    makeMold({ id: 'M3', usedMinutes: 10 }),
  ]);
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 50, moldId: 'M1' });
  const mv = sys.command({ cmd: 'move', orderId: 'O1' });
  assert.equal(mv.moldId, 'M3'); // M3 无需保养，M2 需要 1 次
});

test('取消工单释放占用，撤销按原位置恢复', () => {
  const sys = setup([makeMold({ id: 'M1' })]);
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 });
  sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 30 });
  const cx = sys.command({ cmd: 'cancel', orderId: 'O1' });
  assert.deepEqual(sys.state.molds.M1.queue, ['O2']);
  sys.command({ cmd: 'undo', txId: cx.txId });
  assert.deepEqual(sys.state.molds.M1.queue, ['O1', 'O2']);
});

test('增量更正时长触发保养，撤销恢复寿命与占用', () => {
  const sys = setup([makeMold({ id: 'M1', cycleMinutes: 100, maintenanceMinutes: 20 })]);
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 });
  const before = sys.schedule().M1;
  assert.equal(maintEvents(before).length, 0);
  const c = sys.command({ cmd: 'correct', orderId: 'O1', deltaMinutes: 100 });
  assert.equal(c.durationMinutes, 130);
  const after = sys.schedule().M1;
  assert.equal(maintEvents(after).length, 1); // 130 > 100，工单中段保养
  assert.equal(orderEvents(after)[0].end, 150);
  sys.command({ cmd: 'undo', txId: c.txId });
  const restored = sys.schedule().M1;
  assert.equal(maintEvents(restored).length, 0);
  assert.equal(restored.usedFinal, 30);
  assert.equal(sys.state.orders.O1.durationMinutes, 30);
});

test('撤销的撤销 = 重做', () => {
  const sys = setup([makeMold({ id: 'M1' })]);
  const r = sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 });
  const u = sys.command({ cmd: 'undo', txId: r.txId });
  assert.equal(sys.state.orders.O1, undefined);
  sys.command({ cmd: 'undo', txId: u.txId });
  assert.ok(sys.state.orders.O1);
  assert.deepEqual(sys.state.molds.M1.queue, ['O1']);
});

test('错误路径：未知工单 / 重复撤销 / 未知命令', () => {
  const sys = setup([makeMold({ id: 'M1' })]);
  assert.throws(() => sys.command({ cmd: 'cancel', orderId: 'NOPE' }), /unknown order/);
  const r = sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 });
  sys.command({ cmd: 'undo', txId: r.txId });
  assert.throws(() => sys.command({ cmd: 'undo', txId: r.txId }), /already undone/);
  assert.throws(() => sys.command({ cmd: 'undo', txId: 999 }), /unknown txId/);
  assert.throws(() => sys.command({ cmd: 'bogus' }), /unknown command/);
  assert.throws(() => sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 10, moldId: 'GHOST' }), /not found/);
});

test('重复工单号与非法时长被拒绝', () => {
  const sys = setup([makeMold({ id: 'M1' })]);
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 });
  assert.throws(() => sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 }), /already exists/);
  assert.throws(() => sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 0 }), /> 0/);
  assert.throws(() => sys.command({ cmd: 'correct', orderId: 'O1', deltaMinutes: -30 }), /would become/);
});
