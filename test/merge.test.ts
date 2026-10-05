import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  merge3,
  unmerge,
  reconstruct,
  joinLines,
  type MergeResult,
} from '../src/merge.js';

function m(base: string, ours: string, theirs: string): MergeResult {
  const split = (s: string) => (s === '' ? [] : s.split('\n'));
  return merge3(split(base), split(ours), split(theirs));
}

function assertReversible(result: MergeResult, base: string[], ours: string[], theirs: string[]) {
  // structural reversibility: the MergeResult always retains all three inputs
  assert.deepEqual(reconstruct(result), { base, ours, theirs });
  // textual reversibility: the rendered markers alone recover all three
  // inputs exactly when every differing region is a conflict (no cleanly
  // applied change segments, whose base content only lives in the structure)
  if (!result.segments.some((s) => s.kind === 'change')) {
    assert.deepEqual(unmerge(result.text), { base, ours, theirs });
  }
}

test('adjacent, non-overlapping edits on both sides merge cleanly', () => {
  // ours edits line 0, theirs edits the immediately following line 1
  const r = m('a\nb\nc', 'A\nb\nc', 'a\nB\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'A\nB\nc\n');
});

test('edits separated by context merge cleanly', () => {
  const r = m('a\nb\nc\nd\ne', 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'A\nb\nc\nd\nE\n');
});

test('deletion adjacent to modification merges cleanly', () => {
  // ours deletes line 1, theirs rewrites line 2
  const r = m('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nC\nd');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nC\nd\n');
});

test('same-point insertion of different content conflicts', () => {
  const r = m('a\nb', 'a\nX\nb', 'a\nY\nb');
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.deepEqual(c.baseLines, []); // zero-width base range at the point
  assert.equal(c.baseStart, 1);
  assert.equal(c.baseEnd, 1);
  assert.deepEqual(c.oursLines, ['X']);
  assert.deepEqual(c.theirsLines, ['Y']);
  assert.equal(
    r.text,
    'a\n<<<<<<< ours\nX\n||||||| base\n=======\nY\n>>>>>>> theirs\nb\n',
  );
});

test('same-point insertion of identical content merges cleanly', () => {
  const r = m('a\nb', 'a\nX\nb', 'a\nX\nb');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nX\nb\n');
});

test('overlapping different edits conflict and preserve the base range', () => {
  const r = m('a\nb\nc\nd', 'a\nB1\nC1\nd', 'a\nB2\nC2\nd');
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.baseStart, 1);
  assert.equal(c.baseEnd, 3);
  assert.deepEqual(c.baseLines, ['b', 'c']); // original branch range kept
  assert.deepEqual(c.oursLines, ['B1', 'C1']);
  assert.deepEqual(c.theirsLines, ['B2', 'C2']);
  assert.equal(
    r.text,
    'a\n<<<<<<< ours\nB1\nC1\n||||||| base\nb\nc\n=======\nB2\nC2\n>>>>>>> theirs\nd\n',
  );
});

test('identical change on both sides merges cleanly', () => {
  const r = m('a\nb\nc', 'a\nB\nc', 'a\nB\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nB\nc\n');
});

test('insertion at the boundary of the other side\'s hunk merges cleanly', () => {
  // ours inserts before line 1; theirs replaces line 1
  const r = m('a\nb\nc', 'a\nX\nb\nc', 'a\nB\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nX\nB\nc\n');
});

test('insertion strictly inside the other side\'s hunk conflicts', () => {
  // ours replaces lines 0..2, theirs inserts between them
  const r = m('a\nb', 'X\nY', 'a\nM\nb');
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].oursLines, ['X', 'Y']);
  assert.deepEqual(r.conflicts[0].theirsLines, ['a', 'M', 'b']);
});

test('empty base: both sides adding different content conflicts at point 0', () => {
  const r = m('', 'x', 'y');
  assert.equal(r.clean, false);
  assert.equal(r.conflicts[0].baseStart, 0);
  assert.deepEqual(r.conflicts[0].baseLines, []);
});

test('only one side changed: result equals that side', () => {
  const r = m('a\nb\nc', 'a\nB\nc\nd', 'a\nb\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nB\nc\nd\n');
});

test('both sides delete the same line cleanly', () => {
  const r = m('a\nb\nc', 'a\nc', 'a\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nc\n');
});

test('multiple conflicts in one document', () => {
  const r = m('a\nb\nc\nd\ne', 'A1\nb\nc\nD1\ne', 'A2\nb\nc\nD2\ne');
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 2);
  assert.deepEqual(r.conflicts[0].baseLines, ['a']);
  assert.deepEqual(r.conflicts[1].baseLines, ['d']);
});

test('custom labels are used in conflict markers', () => {
  const split = (s: string) => s.split('\n');
  const r = merge3(split('a'), split('x'), split('y'), {
    ours: 'HEAD',
    base: 'ancestor',
    theirs: 'feature',
  });
  assert.ok(r.text.includes('<<<<<<< HEAD'));
  assert.ok(r.text.includes('||||||| ancestor'));
  assert.ok(r.text.includes('>>>>>>> feature'));
});

test('results are reversible across a matrix of cases', () => {
  const split = (s: string) => (s === '' ? [] : s.split('\n'));
  const cases: Array<[string, string, string]> = [
    ['a\nb\nc', 'A\nb\nc', 'a\nb\nC'],
    ['a\nb\nc', 'a\nX\nb\nc', 'a\nb\nY\nc'],
    ['a\nb\nc', 'A\nB\nc', 'a\nb\nC'],
    ['a\nb\nc', 'x\ny', 'a\nb\nc\nz'],
    ['', 'x', 'y'],
    ['a\nb', 'a', 'a\nb\nB'],
    ['a\nb\nc\nd\ne\nf', 'A\nb\nc\nD1\ne\nf', 'a\nB2\nc\nD2\ne\nF'],
    ['same\nsame', 'same\nsame', 'same\nsame'],
    ['a\nb\nc', '', 'a\nb\nc'],
    ['a\nb\nc', '', 'x'],
  ];
  for (const [b, o, t] of cases) {
    const r = m(b, o, t);
    assertReversible(r, split(b), split(o), split(t));
  }
});

test('joinLines round-trips with trailing newline', () => {
  assert.equal(joinLines(['a', 'b']), 'a\nb\n');
  assert.equal(joinLines([]), '');
});
