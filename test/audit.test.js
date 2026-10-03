import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, runWorld, auditWorld, readJsonl } from '../support/helpers.js';

const plant = {
  factories: [{ id: 'F1', workshops: [{ id: 'W1', kettles: ['K1', 'K2'] }] }],
};

function world() {
  return makeWorld({
    recipes: {
      plant,
      versions: [{ id: 'v1', seq: 1 }, { id: 'v2', seq: 2 }],
      forbidden: [{ pair: ['v1', 'v2'] }],
    },
    approvals: [
      { id: 'a1', kind: 'grant', level: 'factory', target: 'F1', version: '*', ts: 1 },
      { id: 'r1', kind: 'revoke', revokes: 'a1', reason: 'supplier issue', ts: 5 },
    ],
    attempts: [
      { id: 't1', kettle: 'K1', version: 'v1', operator: 'op1', ts: 2 },
      { id: 't2', kettle: 'K2', version: 'v2', operator: 'op1', ts: 3 },
      { id: 't3', kettle: 'K1', version: 'v2', operator: 'op1', ts: 4 },
      { id: 't4', kettle: 'K2', version: 'v2', operator: 'op1', ts: 6 },
    ],
  });
}

test('audit replays each kettle and verifies proofs (exit 0)', () => {
  const dir = world();
  assert.equal(runWorld(dir).status, 0);
  const res = auditWorld(dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /audit ok: 2 feeds verified across 2 kettle\(s\), 1 deviation\(s\)/);
});

test('audit detects a tampered allow.jsonl (exit 1)', () => {
  const dir = world();
  assert.equal(runWorld(dir).status, 0);
  const allowPath = path.join(dir, 'allow.jsonl');
  const rows = readJsonl(allowPath);
  rows[3].decision = 'allow'; // t4 was denied (approval revoked at ts 5)
  fs.writeFileSync(allowPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const res = auditWorld(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /allow\.jsonl does not match replay/);
});

test('audit detects a tampered proof file (exit 1)', () => {
  const dir = world();
  assert.equal(runWorld(dir).status, 0);
  const p = path.join(dir, 'proof', 'kettle-K1.json');
  const proof = JSON.parse(fs.readFileSync(p, 'utf8'));
  proof.feeds[0].approval = 'forged';
  fs.writeFileSync(p, JSON.stringify(proof, null, 2));
  const res = auditWorld(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /proof mismatch for kettle K1/);
});
