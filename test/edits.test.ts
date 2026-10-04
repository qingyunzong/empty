import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, type Edit } from '../src/edits.ts';

/** 参考实现：排序校验后用切片拼接，作为枚举测试的对照 */
function referenceApply(original: string, edits: readonly Edit[]): string {
  const sorted = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i)
    .map(({ e }) => e);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].start < sorted[k - 1].end) throw new RangeError('overlap');
  }
  let out = '';
  let cursor = 0;
  for (const e of sorted) {
    out += original.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + original.slice(cursor);
}

/** 每个编辑在新文中的区间，按排序后布局计算，返回 [edit, newStart, newEnd] */
function newRanges(edits: readonly Edit[]): Array<[Edit, number, number]> {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const ranges: Array<[Edit, number, number]> = [];
  let cursor = 0;
  let newCursor = 0;
  for (const e of sorted) {
    newCursor += e.start - cursor;
    ranges.push([e, newCursor, newCursor + e.text.length]);
    newCursor += e.text.length;
    cursor = e.end;
  }
  return ranges;
}

/** 原文位置 p 严格落在所有非空编辑的闭区间之外（含接缝的位置不参与复合恒等断言，
 *  接缝处的歧义行为由专项测试覆盖） */
function inPreservedInterior(edits: readonly Edit[], p: number): boolean {
  return !edits.some((e) => e.start < e.end && p >= e.start && p <= e.end);
}

function checkComposition(original: string, edits: readonly Edit[]): void {
  const r = applyEdits(original, edits);
  assert.equal(r.text, referenceApply(original, edits), `text for ${JSON.stringify(edits)}`);
  const ranges = newRanges(edits);
  for (const affinity of ['left', 'right'] as const) {
    // 保留区间内部位置：正向再逆向必须回到自身
    for (let p = 0; p <= original.length; p++) {
      if (!inPreservedInterior(edits, p)) continue;
      const q = r.mapForward(p, affinity);
      assert.equal(
        r.mapBackward(q, affinity),
        p,
        `roundtrip orig ${p} (${affinity}) edits=${JSON.stringify(edits)}`,
      );
    }
    // 新文保留区间内部位置：逆向再正向必须回到自身
    for (let q = 0; q <= r.text.length; q++) {
      if (ranges.some(([, ns, ne]) => q >= ns && q <= ne)) continue;
      const p = r.mapBackward(q, affinity);
      assert.equal(
        r.mapForward(p, affinity),
        q,
        `roundtrip new ${q} (${affinity}) edits=${JSON.stringify(edits)}`,
      );
    }
    // 删除/替换区间内部：正向映射按亲和绑定到边缘，且边缘可逆
    for (const [e, ns, ne] of ranges) {
      if (e.start === e.end) continue;
      for (let p = e.start + 1; p < e.end; p++) {
        const expect = affinity === 'left' ? ns : ne;
        assert.equal(r.mapForward(p, affinity), expect, `deleted ${p} -> edge`);
      }
      // 替换文本内部逆向映射回原区间边缘
      for (let q = ns + 1; q < ne; q++) {
        const expect = affinity === 'left' ? e.start : e.end;
        assert.equal(r.mapBackward(q, affinity), expect, `inserted ${q} -> edge`);
      }
    }
  }
}

test('枚举：短文本上全部单编辑与双编辑组合，核对文本与映射复合', () => {
  const originals = ['', 'a', 'ab', 'abc'];
  const replacements = ['', 'X', 'YZ'];
  for (const original of originals) {
    const n = original.length;
    const singles: Edit[][] = [[]];
    for (let s = 0; s <= n; s++) {
      for (let e = s; e <= n; e++) {
        for (const text of replacements) {
          singles.push([{ start: s, end: e, text }]);
        }
      }
    }
    for (const edits of singles) {
      checkComposition(original, edits);
      // 双编辑：所有有序对，重叠的必须抛错，合法的必须核对
      for (const other of singles) {
        if (edits.length === 0) break;
        if (other.length === 0) continue;
        const pair = [...edits, ...other];
        const overlaps = (
          a: Edit,
          b: Edit,
        ): boolean => a.start < b.end && b.start < a.end;
        const bad = overlaps(edits[0], other[0]);
        if (bad) {
          assert.throws(() => applyEdits(original, pair), RangeError);
        } else {
          checkComposition(original, pair);
        }
      }
    }
  }
});

test('同点插入按请求顺序生效', () => {
  const r = applyEdits('ab', [
    { start: 1, end: 1, text: 'X' },
    { start: 1, end: 1, text: 'Y' },
    { start: 1, end: 1, text: 'Z' },
  ]);
  assert.equal(r.text, 'aXYZb');
  // 与请求顺序无关的排序不应改变结果：逆序请求得到逆序文本
  const r2 = applyEdits('ab', [
    { start: 1, end: 1, text: 'Z' },
    { start: 1, end: 1, text: 'Y' },
    { start: 1, end: 1, text: 'X' },
  ]);
  assert.equal(r2.text, 'aZYXb');
});

test('重叠区间拒绝，相邻区间接受', () => {
  assert.throws(
    () => applyEdits('abcd', [{ start: 0, end: 2, text: '' }, { start: 1, end: 3, text: '' }]),
    RangeError,
  );
  // 插入点严格落在替换区间内部 -> 拒绝
  assert.throws(
    () => applyEdits('abcd', [{ start: 1, end: 3, text: 'X' }, { start: 2, end: 2, text: 'Y' }]),
    RangeError,
  );
  // 相邻 [0,2) [2,4) 合法
  const r = applyEdits('abcd', [
    { start: 0, end: 2, text: 'X' },
    { start: 2, end: 4, text: 'Y' },
  ]);
  assert.equal(r.text, 'XY');
  // 插入点在替换区间边界合法
  const r2 = applyEdits('abcd', [
    { start: 1, end: 3, text: 'X' },
    { start: 3, end: 3, text: 'Y' },
  ]);
  assert.equal(r2.text, 'aXYd');
});

test('非法区间与越界位置抛错', () => {
  assert.throws(() => applyEdits('ab', [{ start: -1, end: 1, text: '' }]), RangeError);
  assert.throws(() => applyEdits('ab', [{ start: 2, end: 1, text: '' }]), RangeError);
  assert.throws(() => applyEdits('ab', [{ start: 0, end: 3, text: '' }]), RangeError);
  assert.throws(() => applyEdits('ab', [{ start: 0.5, end: 1, text: '' }]), RangeError);
  const r = applyEdits('ab', []);
  assert.throws(() => r.mapForward(3), RangeError);
  assert.throws(() => r.mapBackward(-1), RangeError);
});

test('删除内部位置按左/右亲和绑定边缘', () => {
  // 'abcde' 删除 [1,4) 替换为 'XY' -> 'aXYe'
  const r = applyEdits('abcde', [{ start: 1, end: 4, text: 'XY' }]);
  assert.equal(r.text, 'aXYe');
  // 内部位置 2、3：左亲和 -> 1（替换文本起点），右亲和 -> 3（替换文本终点）
  for (const p of [2, 3]) {
    assert.equal(r.mapForward(p, 'left'), 1);
    assert.equal(r.mapForward(p, 'right'), 3);
  }
  // 边界：1 归左侧（-> 1），4 归右侧（-> 3）
  assert.equal(r.mapForward(1), 1);
  assert.equal(r.mapForward(4), 3);
  // 逆向：替换文本内部 q=2，左亲和 -> 原左边缘 1，右亲和 -> 原右边缘 4
  assert.equal(r.mapBackward(2, 'left'), 1);
  assert.equal(r.mapBackward(2, 'right'), 4);
  assert.equal(r.mapBackward(1), 1);
  assert.equal(r.mapBackward(3), 4);
});

test('纯删除坍缩到同一点', () => {
  const r = applyEdits('abcde', [{ start: 1, end: 4, text: '' }]);
  assert.equal(r.text, 'ae');
  for (const p of [1, 2, 3]) {
    assert.equal(r.mapForward(p, 'left'), 1);
    assert.equal(r.mapForward(p, 'right'), 1);
  }
  assert.equal(r.mapForward(4), 1);
  // 接缝（删除坍缩点）逆向映射取左侧：新文位置 1 同时是 gap 终点与 'e' 的起点
  assert.equal(r.mapBackward(1), 1);
  assert.equal(r.mapBackward(1, 'right'), 1);
});

test('插入点位置的双向亲和', () => {
  const r = applyEdits('ab', [{ start: 1, end: 1, text: 'XY' }]);
  assert.equal(r.text, 'aXYb');
  assert.equal(r.mapForward(1, 'left'), 1); // 插入文本之前
  assert.equal(r.mapForward(1, 'right'), 3); // 插入文本之后
  assert.equal(r.mapBackward(2, 'left'), 1); // 插入文本内部 -> 插入点
  assert.equal(r.mapBackward(2, 'right'), 1);
  // 同点多次插入：右亲和越过全部插入
  const r2 = applyEdits('ab', [
    { start: 1, end: 1, text: 'X' },
    { start: 1, end: 1, text: 'Y' },
  ]);
  assert.equal(r2.mapForward(1, 'left'), 1);
  assert.equal(r2.mapForward(1, 'right'), 3);
  assert.equal(r2.mapBackward(r2.mapForward(1, 'right'), 'right'), 1);
});

test('文末位置映射', () => {
  const r = applyEdits('abc', [{ start: 3, end: 3, text: 'de' }]);
  assert.equal(r.text, 'abcde');
  assert.equal(r.mapForward(3, 'left'), 3);
  assert.equal(r.mapForward(3, 'right'), 5);
  assert.equal(r.mapBackward(5), 3);
  const r2 = applyEdits('abc', [{ start: 1, end: 3, text: '' }]);
  assert.equal(r2.mapForward(3), 1);
  assert.equal(r2.mapBackward(1), 1); // 接缝取左
});
