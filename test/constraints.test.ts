import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkLayout, edgeValue, overlaps } from '../src/constraints.js';
import { validateSpec } from '../src/model.js';
import { demoSpec, oldLayout } from '../src/instance.js';

test('overlaps: 边贴边不算重叠，相交才算', () => {
  const a = { id: 'a', x: 0, y: 0, w: 2, h: 2 };
  assert.equal(overlaps(a, { id: 'b', x: 2, y: 0, w: 2, h: 2 }), false);
  assert.equal(overlaps(a, { id: 'b', x: 0, y: 2, w: 2, h: 2 }), false);
  assert.equal(overlaps(a, { id: 'b', x: 1, y: 1, w: 2, h: 2 }), true);
  assert.equal(overlaps(a, { id: 'b', x: 0, y: 0, w: 1, h: 1 }), true);
});

test('edgeValue: 中心用 2 倍坐标保持整数', () => {
  const odd = { id: 'a', x: 3, y: 0, w: 3, h: 1 };
  const even = { id: 'b', x: 3, y: 0, w: 4, h: 1 };
  assert.equal(edgeValue(odd, 'hcenter'), 9); // 2*3+3
  assert.equal(edgeValue(even, 'hcenter'), 10); // 2*3+4
  assert.equal(edgeValue(odd, 'left'), 3);
  assert.equal(edgeValue(odd, 'right'), 6);
  assert.equal(edgeValue(odd, 'bottom'), 1);
});

test('checkLayout: 旧演示布局恰好违反 3 条对齐约束', () => {
  const spec = demoSpec();
  const checks = checkLayout(spec, oldLayout(spec));
  const violated = checks.filter((c) => !c.satisfied).map((c) => c.id);
  assert.deepEqual(violated.sort(), [
    'align:D~H:hcenter',
    'align:E~F:right',
    'align:G~H:bottom',
  ]);
});

test('checkLayout: 检出尺寸越界与网格越界', () => {
  const spec = demoSpec();
  const bad = [
    { id: 'A', x: 0, y: 0, w: 99, h: 2 },
    ...oldLayout(spec).filter((p) => p.id !== 'A'),
  ];
  const failed = checkLayout(spec, bad).filter((c) => !c.satisfied).map((c) => c.id);
  assert.ok(failed.includes('size:A'));
  assert.ok(failed.includes('bounds:A'));
});

test('validateSpec: 拒绝非法定义', () => {
  const spec = demoSpec();
  assert.deepEqual(validateSpec(spec), []);
  assert.ok(validateSpec({ ...spec, rects: [...spec.rects, spec.rects[0]!] }).length > 0); // id 重复
  assert.ok(validateSpec({ ...spec, align: [{ a: 'A', b: 'ZZ', edge: 'top' }] }).length > 0); // 未知引用
  const nine = { ...spec, rects: [...spec.rects, { ...spec.rects[0]!, id: 'I' }] };
  assert.ok(validateSpec(nine).some((p) => p.includes('超过上限')));
});
