import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, runCli, tmpStore, readState } from './helpers.js';
import { canonical } from '../src/event.js';

function sync(a, b) {
  return runCli(['sync', '--store', a, '--peer', b]);
}

test('同人并发 assign 不同班组：确定性规则收敛（与同步方向无关）', () => {
  for (const [first, second] of [['A', 'B'], ['B', 'A']]) {
    const A = tmpStore('cf-a');
    const B = tmpStore('cf-b');
    const create = emit(A, 'SA', 'create', 'WO-1').stdout.event;
    assert.equal(runCli(['apply', '--store', B, '--event', JSON.stringify(create)]).code, 0);
    // 同一操作员 wang 在两个站点并发指派不同班组
    emit(A, 'SA', 'assign', 'WO-1', ['--data', '{"team":"beta"}', '--actor', 'wang']);
    emit(B, 'SB', 'assign', 'WO-1', ['--data', '{"team":"alpha"}', '--actor', 'wang']);
    const r = first === 'A' ? sync(A, B) : sync(B, A);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.converged, true);
    const oa = readState(A).orders['WO-1'];
    const ob = readState(B).orders['WO-1'];
    assert.equal(canonical(oa), canonical(ob));
    // 确定性规则：(team, site, seq) 字典序小者胜 -> alpha
    assert.equal(oa.team, 'alpha');
    const conflicts = readState(A).conflicts;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'assign-team');
    assert.equal(conflicts[0].rule, 'team-lexicographic');
    // 再反向同步一次仍幂等
    const r2 = first === 'A' ? sync(B, A) : sync(A, B);
    assert.equal(r2.stdout.transferred, 0);
  }
});

test('安全联锁工单冲突 -> 双方挂起 pending，sync 退出码 9', () => {
  const A = tmpStore('sf-a');
  const B = tmpStore('sf-b');
  const create = emit(A, 'SA', 'create', 'WO-9', ['--data', '{"safety":true}']).stdout.event;
  assert.equal(runCli(['apply', '--store', B, '--event', JSON.stringify(create)]).code, 0);
  emit(A, 'SA', 'assign', 'WO-9', ['--data', '{"team":"beta"}', '--actor', 'wang']);
  emit(B, 'SB', 'assign', 'WO-9', ['--data', '{"team":"alpha"}', '--actor', 'wang']);
  const r = sync(A, B);
  assert.equal(r.code, 9);
  assert.equal(r.stdout.heldCount, 2);
  assert.equal(r.stdout.conflicts[0].kind, 'safety-interlock');
  assert.equal(r.stdout.conflicts[0].status, 'pending');
  // 双方状态一致：工单停留在 created，两个 assign 均未生效
  const oa = readState(A).orders['WO-9'];
  const ob = readState(B).orders['WO-9'];
  assert.equal(canonical(oa), canonical(ob));
  assert.equal(oa.status, 'created');
  assert.equal(oa.team, null);
  const decisions = readState(A).decisions;
  const held = Object.values(decisions).filter((s) => s === 'held');
  assert.equal(held.length, 2);
});
