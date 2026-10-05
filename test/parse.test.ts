import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstance } from '../src/parse.js';

test('合法输入解析成功，rotate 缺省为 false', () => {
  const i = parseInstance({
    grid: { width: 8, height: 8, forbidden: [[0, 0]] },
    rectangles: [{ id: 'a', w: 1, h: 2, profit: 3 }],
  });
  assert.equal(i.grid.width, 8);
  assert.deepEqual(i.grid.forbidden, [[0, 0]]);
  assert.equal(i.rectangles[0]!.rotate, false);
});

test('网格超过 8x8 被拒绝', () => {
  assert.throws(() => parseInstance({ grid: { width: 9, height: 8 }, rectangles: [] }), /grid\.width/);
});

test('矩形超过 10 个被拒绝', () => {
  const rectangles = Array.from({ length: 11 }, (_, k) => ({ id: `r${k}`, w: 1, h: 1, profit: 1 }));
  assert.throws(() => parseInstance({ grid: { width: 8, height: 8 }, rectangles }), /超过上限 10/);
});

test('禁区越界 / id 重复 / 负收益被拒绝', () => {
  assert.throws(
    () => parseInstance({ grid: { width: 2, height: 2, forbidden: [[2, 0]] }, rectangles: [] }),
    /越界/,
  );
  assert.throws(
    () =>
      parseInstance({
        grid: { width: 2, height: 2 },
        rectangles: [
          { id: 'a', w: 1, h: 1, profit: 1 },
          { id: 'a', w: 1, h: 1, profit: 1 },
        ],
      }),
    /重复/,
  );
  assert.throws(
    () => parseInstance({ grid: { width: 2, height: 2 }, rectangles: [{ id: 'a', w: 1, h: 1, profit: -1 }] }),
    /profit/,
  );
});
