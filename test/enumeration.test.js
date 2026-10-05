import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive } from '../src/archive.js';
import { Querier } from '../src/query.js';
import { genEvents, bruteForce } from './helpers.js';

const VOCAB = ['a', 'b', 'c'];
const DEVICES = ['d1', 'd2'];
const N = 6;

function phrases() {
  const out = [];
  for (const x of VOCAB) out.push([x]);
  for (const x of VOCAB) for (const y of VOCAB) out.push([x, y]);
  for (const x of VOCAB) for (const y of VOCAB) for (const z of VOCAB) out.push([x, y, z]);
  return out;
}

function nearQueries() {
  const out = [];
  for (const a of VOCAB) for (const b of VOCAB) for (let k = 0; k <= 3; k++) out.push({ a, b, k });
  return out;
}

// Acceptance 1: enumerate small event streams and every freeze-window split,
// then compare phrase + cross-segment proximity queries against a naive oracle.
test('all freeze windows match brute-force oracle', { timeout: 120000 }, () => {
  for (const seed of [1, 2, 3]) {
    const events = genEvents(seed, N, VOCAB, DEVICES);
    for (let mask = 0; mask < 1 << (N - 1); mask++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-enum-'));
      const archive = new Archive(dir);
      events.forEach((e, i) => {
        archive.append(e);
        if (mask & (1 << i) && i < N - 1) archive.freeze();
      });
      const querier = new Querier(archive);
      for (const tokens of phrases()) {
        const got = querier.phrase(tokens);
        const want = bruteForce(events, -Infinity, { type: 'phrase', tokens });
        assert.deepEqual(got, want, `seed=${seed} mask=${mask} phrase=${tokens.join(' ')}`);
      }
      for (const q of nearQueries()) {
        const got = querier.near(q.a, q.b, q.k);
        const want = bruteForce(events, -Infinity, { type: 'near', ...q });
        assert.deepEqual(got, want, `seed=${seed} mask=${mask} near=${q.a},${q.b},${q.k}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('cross-segment boundary phrase and near hits are found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-bound-'));
  const archive = new Archive(dir);
  archive.append({ ts: 1, device: 'd1', tokens: 'alpha beta' });
  archive.freeze();
  archive.append({ ts: 2, device: 'd1', tokens: 'gamma delta' });
  archive.freeze();
  archive.append({ ts: 3, device: 'd1', tokens: 'epsilon alpha' });
  const querier = new Querier(archive);
  // 'beta gamma' spans seg1->seg2, 'delta epsilon' spans seg2->active
  assert.equal(querier.phrase('beta gamma').length, 1);
  assert.equal(querier.phrase('delta epsilon').length, 1);
  const hits = querier.near('alpha', 'delta', 3);
  assert.ok(hits.some((h) => h.events.includes('e00000001') && h.events.includes('e00000002')));
  fs.rmSync(dir, { recursive: true, force: true });
});
