import test from 'node:test';
import assert from 'node:assert/strict';

import { GeometryRegistry } from '../dist/geometry.js';

const box = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

test('live 引用归零即回收', () => {
  const reg = new GeometryRegistry();
  reg.register({ id: 'g1', localBounds: box });
  reg.retainLive('g1');
  reg.retainLive('g1');
  assert.equal(reg.has('g1'), true);
  reg.releaseLive('g1');
  assert.equal(reg.has('g1'), true);
  reg.releaseLive('g1');
  assert.equal(reg.has('g1'), false);
  assert.throws(() => reg.get('g1'), /not registered/);
});

test('版本引用在版本释放后才允许回收', () => {
  const reg = new GeometryRegistry();
  reg.register({ id: 'g1', localBounds: box });
  reg.retainLive('g1');
  reg.retainVersion('g1', 2);
  reg.releaseLive('g1');
  // live 归零但版本仍持有
  assert.equal(reg.has('g1'), true);
  reg.releaseVersion('g1', 1);
  assert.equal(reg.has('g1'), true);
  reg.releaseVersion('g1', 1);
  assert.equal(reg.has('g1'), false);
});

test('引用下溢与重复注册被拒绝', () => {
  const reg = new GeometryRegistry();
  reg.register({ id: 'g1', localBounds: box });
  assert.throws(() => reg.releaseLive('g1'), /underflow/);
  assert.throws(
    () => reg.register({ id: 'g1', localBounds: box }),
    /already registered/,
  );
});

test('refInfo 暴露两类计数', () => {
  const reg = new GeometryRegistry();
  reg.register({ id: 'g1', localBounds: box });
  reg.retainLive('g1');
  reg.retainVersion('g1', 3);
  assert.deepEqual(reg.refInfo('g1'), {
    id: 'g1',
    liveRefs: 1,
    versionRefs: 3,
    disposed: false,
  });
  assert.equal(reg.refInfo('missing'), null);
});
