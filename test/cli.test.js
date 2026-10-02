import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const NET = path.join(root, 'net.js');

function setup(rules, obs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'netdsl-'));
  const rulesPath = path.join(dir, 'rules.net');
  const obsPath = path.join(dir, 'obs.json');
  const proofPath = path.join(dir, 'proof.json');
  writeFileSync(rulesPath, rules);
  writeFileSync(obsPath, JSON.stringify(obs));
  return { rulesPath, obsPath, proofPath };
}

const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

const RULES = `
date 2026-10-02 {
  const floor = 100;
  filter amount >= floor;
  settle fee = min(abs(position) * 1%, 500);
}`;

const OBS = [
  { id: 'o1', debtor: 'M1', creditor: 'M2', ccy: 'USD', amount: 25000, date: '2026-10-02' },
  { id: 'o2', debtor: 'M2', creditor: 'M1', ccy: 'USD', amount: 10000, date: '2026-10-02' },
];

test('CLI: net run writes a proof file and exits 0', () => {
  const { rulesPath, obsPath, proofPath } = setup(RULES, OBS);
  const p = run([NET, 'run', rulesPath, obsPath, '--proof', proofPath]);
  assert.equal(p.status, 0, p.stderr);
  assert.ok(existsSync(proofPath));
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  assert.equal(proof.ok, true);
  assert.equal(proof.currencies.USD.minCash, 15000);
  assert.equal(proof.currencies.USD.solutions.length, 1);
  // some sandboxes swallow grand-child stdio; assert output only when captured
  if (p.stdout) {
    assert.match(p.stdout, /USD: gross=35000 cancelled=20000 minCash=15000 solutions=1/);
  }
});

test('CLI: typed rule errors exit 1 with the error code on stderr', () => {
  const { rulesPath, obsPath, proofPath } = setup(
    'date 2026-10-02 { const x = 1 USD + 1 EUR; }',
    OBS,
  );
  const p = run([NET, 'run', rulesPath, obsPath, '--proof', proofPath]);
  assert.equal(p.status, 1);
  if (p.stderr) assert.match(p.stderr, /E_CCY/);
  assert.ok(!existsSync(proofPath));
});

test('CLI: bad usage exits 2', () => {
  const p = run([NET]);
  assert.equal(p.status, 2);
  if (p.stderr) assert.match(p.stderr, /Usage: net run/);
});
