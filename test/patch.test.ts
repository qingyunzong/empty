import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatches, revert, formatEvidence,
  type ApplyResult, type PatchSpec,
} from '../src/patch';

function mustOk(r: ApplyResult): asserts r is Extract<ApplyResult, { ok: true }> {
  assert.ok(r.ok, JSON.stringify(r));
}
function mustFail(r: ApplyResult): asserts r is Extract<ApplyResult, { ok: false }> {
  assert.ok(!r.ok, JSON.stringify(r));
}

function spec(baseline: string, search: string, replacement: string): PatchSpec {
  const start = baseline.indexOf(search);
  assert.notEqual(start, -1, `search string not in baseline: ${search}`);
  return { start, end: start + search.length, replacement };
}

test('unchanged target: range applied verbatim', () => {
  const baseline = 'hello world';
  const r = applyPatches(baseline, baseline, [spec(baseline, 'world', 'there')]);
  mustOk(r);
  assert.equal(r.result, 'hello there');
  assert.equal(r.evidence[0]!.mode, 'unchanged');
  assert.equal(revert(r.result, r.reverse), baseline);
});

test('modified target: relocated by content, offsets shift tracked', () => {
  const baseline = 'alpha beta gamma';
  const target = 'PREFIX alpha beta gamma SUFFIX';
  const r = applyPatches(baseline, target, [spec(baseline, 'beta', 'BETA')]);
  mustOk(r);
  assert.equal(r.result, 'PREFIX alpha BETA gamma SUFFIX');
  assert.equal(r.evidence[0]!.mode, 'exact');
  assert.equal(r.evidence[0]!.range.start, target.indexOf('beta'));
  assert.equal(revert(r.result, r.reverse), target);
});

test('small repeated string: all occurrences enumerated, unique context wins', () => {
  const baseline = 'a=1; b=1; c=1;';
  const target = '<< a=1; b=1; c=1; >>'; // shifted, content intact
  const p = spec(baseline, 'b=1', 'b=2');
  const r = applyPatches(baseline, target, [p]);
  mustOk(r);
  assert.equal(r.result, '<< a=1; b=2; c=1; >>');
  const ev = r.evidence[0]!;
  assert.equal(ev.mode, 'exact');
  assert.equal(revert(r.result, r.reverse), target);
});

test('repeated small string disambiguated by context scores', () => {
  const baseline = 'x=1; y=1; z=1;';
  const target = baseline;
  // patch the "1" after "y=" — "1" occurs 3 times
  const start = baseline.indexOf('y=') + 2;
  const r = applyPatches(baseline, target, [{ start, end: start + 1, replacement: '2' }]);
  mustOk(r);
  assert.equal(r.result, 'x=1; y=2; z=1;');
  const ev = r.evidence[0]!;
  assert.equal(ev.mode, 'unchanged'); // target === baseline
  // now with a modified target so enumeration actually runs
  const target2 = '  ' + baseline; // shifted, content identical
  const r2 = applyPatches(baseline, target2, [{ start, end: start + 1, replacement: '2' }]);
  mustOk(r2);
  assert.equal(r2.result, '  x=1; y=2; z=1;');
  const ev2 = r2.evidence[0]!;
  assert.equal(ev2.mode, 'exact-disambiguated');
  assert.equal(ev2.candidates.length, 3, 'all three occurrences enumerated');
  assert.equal(ev2.range.start, target2.indexOf('y=') + 2);
  assert.equal(revert(r2.result, r2.reverse), target2);
});

test('ambiguity: identical repeated context is reported, never guessed', () => {
  // Both copies of "aXa" in the target match the baseline context equally,
  // so no unique best exists.
  const baseline = 'aXa';
  const target = 'aXa aXa';
  const start = baseline.indexOf('X');
  const r = applyPatches(baseline, target, [{ start, end: start + 1, replacement: '9' }]);
  mustFail(r);
  assert.equal(r.errors.length, 1);
  const err = r.errors[0]!;
  assert.equal(err.kind, 'ambiguous');
  if (err.kind === 'ambiguous') {
    assert.equal(err.candidates.length, 2, 'both candidates reported');
  }
});

test('content itself modified: located via context anchors', () => {
  const baseline = 'const answer = 1;';
  const target = 'const answer = 999;';
  const p = spec(baseline, '1', '2');
  const r = applyPatches(baseline, target, [p]);
  mustOk(r);
  assert.equal(r.result, 'const answer = 2;');
  const ev = r.evidence[0]!;
  assert.equal(ev.mode, 'context-anchored');
  assert.ok(ev.contextBefore.length > 0);
  assert.equal(revert(r.result, r.reverse), target);
});

test('not found: neither content nor context anchors present', () => {
  const baseline = 'const answer = 1;';
  const target = 'completely different document';
  const r = applyPatches(baseline, target, [spec(baseline, '1', '2')]);
  mustFail(r);
  assert.equal(r.errors[0]!.kind, 'not-found');
});

test('pure insertion at a located point', () => {
  const baseline = 'ab';
  const target = '--ab--';
  const at = baseline.indexOf('b');
  const r = applyPatches(baseline, target, [{ start: at, end: at, replacement: 'X' }]);
  mustOk(r);
  assert.equal(r.result, '--aXb--');
  assert.equal(revert(r.result, r.reverse), target);
});

test('multi-patch: validated as a whole, applied atomically on success', () => {
  const baseline = 'one two three';
  const target = '[one] two three';
  const r = applyPatches(baseline, target, [
    spec(baseline, 'one', 'ONE'),
    spec(baseline, 'three', 'THREE'),
  ]);
  mustOk(r);
  assert.equal(r.result, '[ONE] two THREE');
  assert.equal(r.reverse.length, 2);
  assert.equal(revert(r.result, r.reverse), target);
});

test('multi-patch atomicity: one failing patch blocks the whole set', () => {
  const baseline = 'one two three';
  const target = 'one two three';
  const r = applyPatches(baseline, target, [
    spec(baseline, 'one', 'ONE'),
    { start: 999, end: 1000, replacement: 'X' }, // invalid range
  ]);
  mustFail(r);
  assert.equal(r.errors[0]!.kind, 'invalid-range');
  assert.equal('result' in r, false, 'no partial result on failure');
});

test('multi-patch atomicity: ambiguity in one patch blocks all', () => {
  const baseline = 'aXa';
  const target = 'aXa aXa';
  const start = baseline.indexOf('X');
  const r = applyPatches(baseline, target, [
    { start, end: start + 1, replacement: '9' }, // ambiguous
    { start: 0, end: 1, replacement: 'b' },
  ]);
  mustFail(r);
  assert.ok(r.errors.some((e) => e.kind === 'ambiguous'));
  assert.equal('result' in r, false, 'no partial result on failure');
});

test('overlapping located ranges are rejected', () => {
  const baseline = 'abcdef';
  const r = applyPatches(baseline, baseline, [
    { start: 0, end: 4, replacement: 'X' },
    { start: 2, end: 6, replacement: 'Y' },
  ]);
  mustFail(r);
  assert.equal(r.errors[0]!.kind, 'overlap');
});

test('reverse patches are in result coordinates across shifts', () => {
  const baseline = 'a bb ccc dddd';
  const target = '>> a bb ccc dddd <<';
  const r = applyPatches(baseline, target, [
    spec(baseline, 'bb', 'B'.repeat(10)),
    spec(baseline, 'dddd', 'D'),
  ]);
  mustOk(r);
  assert.equal(r.result, '>> a ' + 'B'.repeat(10) + ' ccc D <<');
  assert.equal(revert(r.result, r.reverse), target);
});

test('small string with repeated context: enumeration evidence is exhaustive', () => {
  // "}" appears many times; only one has the right surrounding context.
  const baseline = 'f(){g(){h(){}}}';
  const target = baseline;
  const start = baseline.indexOf('h(){') + 4; // the "}" closing h
  const target2 = 'xx ' + baseline + ' yy';
  const r = applyPatches(baseline, target2, [{ start, end: start + 1, replacement: '};' }]);
  mustOk(r);
  const ev = r.evidence[0]!;
  assert.equal(ev.mode, 'exact-disambiguated');
  assert.equal(ev.candidates.length, 3, 'every "}" occurrence enumerated');
  const positions = ev.candidates.map((c) => c.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(r.result, 'xx f(){g(){h(){};}} yy');
  assert.equal(revert(r.result, r.reverse), target2);
});

test('formatEvidence renders modes, anchors and candidates', () => {
  const baseline = 'const answer = 1;';
  const target = 'const answer = 999;';
  const r = applyPatches(baseline, target, [spec(baseline, '1', '2')]);
  mustOk(r);
  const text = formatEvidence(r.evidence);
  assert.match(text, /patch #0 \[context-anchored\]/);
  assert.match(text, /anchors: before=/);
  assert.match(text, /candidate \[\d+, \d+\)/);
});
