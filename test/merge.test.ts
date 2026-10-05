import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  merge3,
  mergeLines,
  revert,
  splitLines,
  type ConflictHunk,
} from '../src/merge.js';

const doc = (lines: string[]) => lines.join('\n') + '\n';

test('adjacent but non-overlapping edits from both sides merge cleanly', () => {
  const base = doc(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  const ours = doc(['l1', 'OURS', 'l3', 'l4', 'l5', 'l6']); // edits line 2
  const theirs = doc(['l1', 'l2', 'l3', 'l4', 'THEIRS', 'l6']); // edits line 5
  const r = merge3(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.merged, doc(['l1', 'OURS', 'l3', 'l4', 'THEIRS', 'l6']));
});

test('directly touching (adjacent) ranges from both sides merge cleanly', () => {
  const base = doc(['a', 'b', 'c', 'd']);
  const ours = doc(['A', 'B', 'c', 'd']); // replaces base lines 1-2
  const theirs = doc(['a', 'b', 'C', 'D']); // replaces base lines 3-4
  const r = merge3(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.merged, doc(['A', 'B', 'C', 'D']));
});

test('different insertions at the same point conflict', () => {
  const base = doc(['a', 'b']);
  const ours = doc(['a', 'X', 'b']);
  const theirs = doc(['a', 'Y', 'b']);
  const r = merge3(base, ours, theirs);
  assert.equal(r.clean, false);
  assert.equal(r.conflictCount, 1);
  const h = r.hunks[0] as ConflictHunk;
  assert.equal(h.type, 'conflict');
  assert.equal(h.baseStart, 1);
  assert.equal(h.baseEnd, 1);
  assert.deepEqual(h.baseLines, []);
  assert.deepEqual(h.ours, ['X']);
  assert.deepEqual(h.theirs, ['Y']);
  assert.match(r.merged, /<<<<<<< ours\nX\n\|\|\|\|\|\|\| base\n=======\nY\n>>>>>>> theirs\n/);
});

test('identical insertions at the same point merge once', () => {
  const base = doc(['a', 'b']);
  const ours = doc(['a', 'X', 'b']);
  const theirs = doc(['a', 'X', 'b']);
  const r = merge3(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.merged, doc(['a', 'X', 'b']));
  assert.equal(r.hunks[0].type === 'clean' && r.hunks[0].side, 'both');
});

test('identical replacements on both sides merge once', () => {
  const base = doc(['a', 'b', 'c']);
  const ours = doc(['a', 'B', 'c']);
  const theirs = doc(['a', 'B', 'c']);
  const r = merge3(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.merged, doc(['a', 'B', 'c']));
});

test('overlapping different edits conflict and preserve the original branch ranges', () => {
  const base = doc(['h1', 'h2', 'h3', 'h4']);
  const ours = doc(['h1', 'O2', 'O3', 'h4']); // replaces base lines 2-3
  const theirs = doc(['h1', 'h2', 'T3', 'T4']); // replaces base lines 3-4
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflictCount, 1);
  const h = r.hunks[0] as ConflictHunk;
  assert.equal(h.baseStart, 1);
  assert.equal(h.baseEnd, 4);
  assert.deepEqual(h.baseLines, ['h2', 'h3', 'h4']); // original base range preserved
  assert.deepEqual(h.ours, ['O2', 'O3', 'h4']);
  assert.deepEqual(h.theirs, ['h2', 'T3', 'T4']);
  assert.equal(
    r.merged,
    doc(['h1', '<<<<<<< ours', 'O2', 'O3', 'h4', '||||||| base', 'h2', 'h3', 'h4', '=======', 'h2', 'T3', 'T4', '>>>>>>> theirs']),
  );
});

test('insertion strictly inside the other side\'s replaced range conflicts', () => {
  const base = doc(['a', 'b', 'c', 'd']);
  const ours = doc(['a', 'B', 'd']); // replaced b,c with B
  const theirs = doc(['a', 'b', 'INS', 'c', 'd']); // inserted between b and c
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflictCount, 1);
});

test('insertion at the boundary of the other side\'s edit merges cleanly', () => {
  const base = doc(['a', 'b', 'c']);
  const ours = doc(['a', 'B', 'c']); // replaced line 2
  const theirs = doc(['a', 'INS', 'b', 'c']); // inserted before line 2
  const r = merge3(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.merged, doc(['a', 'INS', 'B', 'c']));
});

test('revert reconstructs every side from merged text + result', () => {
  const base = doc(['h1', 'h2', 'h3', 'h4']);
  const ours = doc(['h1', 'O2', 'O3', 'h4']);
  const theirs = doc(['h1', 'h2', 'T3', 'T4']);
  const r = merge3(base, ours, theirs);
  assert.equal(revert(r.merged, r, 'base'), base);
  assert.equal(revert(r.merged, r, 'ours'), ours);
  assert.equal(revert(r.merged, r, 'theirs'), theirs);
});

test('revert rejects a tampered merged text', () => {
  const base = doc(['a', 'b']);
  const ours = doc(['a', 'X', 'b']);
  const theirs = doc(['a', 'Y', 'b']);
  const r = merge3(base, ours, theirs);
  assert.throws(() => revert(r.merged.replace('X', 'Z'), r, 'ours'), /does not match/);
});

test('randomized round-trip: merge then revert yields all three inputs', () => {
  let state = 7;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const alphabet = ['p', 'q', 'r'];
  const randomDoc = (maxLen: number) =>
    Array.from({ length: Math.floor(rand() * maxLen) }, () => alphabet[Math.floor(rand() * alphabet.length)]);
  for (let iter = 0; iter < 300; iter++) {
    const base = randomDoc(9);
    const ours = randomDoc(9);
    const theirs = randomDoc(9);
    const r = merge3(doc(base), doc(ours), doc(theirs));
    assert.equal(revert(r.merged, r, 'base'), doc(base), `base round-trip (iter ${iter})`);
    assert.equal(revert(r.merged, r, 'ours'), doc(ours), `ours round-trip (iter ${iter})`);
    assert.equal(revert(r.merged, r, 'theirs'), doc(theirs), `theirs round-trip (iter ${iter})`);
  }
});

test('mergeLines keeps hunks sorted by base line number', () => {
  const hunks = mergeLines(
    splitLines(doc(['a', 'b', 'c', 'd', 'e'])),
    splitLines(doc(['A', 'b', 'c', 'd', 'e'])),
    splitLines(doc(['a', 'b', 'c', 'd', 'E'])),
  );
  assert.deepEqual(
    hunks.map((h) => [h.baseStart, h.baseEnd]),
    [
      [0, 1],
      [4, 5],
    ],
  );
});
