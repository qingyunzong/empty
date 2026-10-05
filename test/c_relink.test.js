// Acceptance C: relId mismatch on an otherwise identical event -> relink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLedgers } from '../src/index.js';
import { ev, pair } from './helpers.js';

test('C1: one event points at the wrong relId -> single relink op', () => {
  const left = [
    ev('l1', 'cash', 100, 'debit', 'USD', 'r1'),
    ev('l2', 'revenue', 100, 'credit', 'USD', 'r1'),
  ];
  const right = [
    ev('r1', 'cash', 100, 'debit', 'USD', 'r9'),
    ev('r2', 'revenue', 100, 'credit', 'USD', 'r1'),
  ];
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.minCost, 1);
  const relinks = res.scripts.filter((s) => s.length === 1 && s[0].op === 'relink');
  assert.ok(relinks.length >= 1, 'expected relink scripts');
  assert.ok(
    relinks.some((s) => s[0].side === 'left' && s[0].id === 'l1' && s[0].toRelId === 'r9')
      || relinks.some((s) => s[0].side === 'right' && s[0].id === 'r1' && s[0].toRelId === 'r1'),
  );
});

test('C2: relink is strictly cheaper than remove+add (cost 1 < 2)', () => {
  // The credit on the left points at a typo relId, which both mismatches
  // the right and unbalances the left; one relink repairs everything,
  // whereas remove+add would cost 2.
  const left = [
    ev('l1', 'cash', 100, 'debit', 'USD', 'r1'),
    ev('l2', 'revenue', 100, 'credit', 'USD', 'typo'),
  ];
  const right = [
    ev('r1', 'cash', 100, 'debit', 'USD', 'r1'),
    ev('r2', 'revenue', 100, 'credit', 'USD', 'r1'),
  ];
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.minCost, 1);
  assert.ok(res.scripts.every((s) => s.length === 1));
  assert.ok(res.scripts.some((s) => s[0].op === 'relink' && s[0].side === 'left' && s[0].id === 'l2' && s[0].toRelId === 'r1'));
});
