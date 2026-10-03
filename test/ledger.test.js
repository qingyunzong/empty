'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../src/parser');
const { buildLedger } = require('../src/build');
const { verifyChain, LedgerError } = require('../src/ledger');
const { CheckError } = require('../src/term');

const KEY = 'acceptance-key';
const CHAIN_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'examples', 'chain.txt'), 'utf8');
const REVOKE_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'examples', 'revoke.txt'), 'utf8');

test('acceptance 1: three-evidence chain verifies, transitive deps match manual enumeration', () => {
  const ledger = buildLedger(parse(CHAIN_SCRIPT), KEY);
  const verdict = ledger.verdict();
  assert.equal(verdict.ok, true);
  // Manually enumerated transitive dependencies:
  // C1 <- {E1}; C2 <- C1 + E2 = {E1,E2}; C3 <- C2 + E3 = {E1,E2,E3}.
  assert.deepEqual(verdict.claims.C1.dependencies, ['E1']);
  assert.deepEqual(verdict.claims.C2.dependencies, ['E1', 'E2']);
  assert.deepEqual(verdict.claims.C3.dependencies, ['E1', 'E2', 'E3']);
  // The certificate chain itself verifies against the same key.
  const symbols = verifyChain(ledger.commits, KEY);
  assert.deepEqual([...symbols.get('C3').deps].sort(), ['E1', 'E2', 'E3']);
});

test('acceptance 2: revoking middle evidence kills two downstream claims only', () => {
  const ledger = buildLedger(parse(REVOKE_SCRIPT), KEY);
  const verdict = ledger.verdict();
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.revoked, ['E2']);
  assert.equal(verdict.claims.C2.valid, false);
  assert.equal(verdict.claims.C3.valid, false);
  assert.deepEqual(verdict.claims.C2.revokedDependencies, ['E2']);
  assert.deepEqual(verdict.claims.C3.revokedDependencies, ['E2']);
  // C1 does not depend on E2; IND only depends on E3.
  assert.equal(verdict.claims.C1.valid, true);
  assert.equal(verdict.claims.IND.valid, true);
});

test('undo restores a revocation, redo re-applies it, new op clears redo', () => {
  const ledger = buildLedger(parse(REVOKE_SCRIPT), KEY);
  assert.equal(ledger.verdict().claims.C3.valid, false);
  ledger.undo();
  assert.equal(ledger.verdict().claims.C3.valid, true);
  assert.deepEqual(ledger.verdict().revoked, []);
  ledger.redo();
  assert.equal(ledger.verdict().claims.C3.valid, false);
  ledger.undo();
  assert.equal(ledger.verdict().claims.C3.valid, true);
  // A new operation after undo clears the redo stack.
  ledger.revoke('E1');
  assert.throws(() => ledger.redo(), /nothing to redo/);
  assert.equal(ledger.verdict().claims.C1.valid, false);
  assert.equal(ledger.verdict().claims.IND.valid, true);
});

test('revoke/undo/redo misuse is rejected', () => {
  assert.throws(() => buildLedger(parse('evidence E1\nrevoke E2'), KEY), /unknown evidence/);
  assert.throws(() => buildLedger(parse('rule R1\nrevoke R1'), KEY), /only evidence/);
  assert.throws(() => buildLedger(parse('evidence E1\nundo'), KEY), /nothing to undo/);
  assert.throws(() => buildLedger(parse('evidence E1\nredo'), KEY), /nothing to redo/);
});

test('aliases are scoped: visible in nested blocks, gone outside, duplicates rejected', () => {
  const okScript = [
    'evidence E1',
    'evidence E2',
    'rule R1',
    '{',
    '  alias X = E1 & E2',
    '  {',
    '    claim C1 = X |> R1',
    '  }',
    '}',
  ].join('\n');
  const ledger = buildLedger(parse(okScript), KEY);
  assert.equal(ledger.symbols.get('C1').canon, '((E1 & E2) |> R1)');
  assert.deepEqual([...ledger.symbols.get('C1').deps].sort(), ['E1', 'E2']);

  const escapeScript = [
    'evidence E1',
    'rule R1',
    '{ alias X = E1 }',
    'claim C1 = X |> R1',
  ].join('\n');
  assert.throws(() => buildLedger(parse(escapeScript), KEY), /unknown identifier "X"/);

  const dupScript = 'evidence E1\nalias X = E1\nalias X = E1';
  assert.throws(() => buildLedger(parse(dupScript), KEY), /duplicate alias "X"/);

  const dupNested = 'evidence E1\nalias X = E1\n{ alias X = E1 }';
  assert.throws(() => buildLedger(parse(dupNested), KEY), /duplicate alias "X"/);

  const dupDecl = 'evidence E1\nevidence E1';
  assert.throws(() => buildLedger(parse(dupDecl), KEY), /duplicate declaration of "E1"/);
});

test('static types: evidence, rule and claim are distinguished', () => {
  assert.throws(
    () => buildLedger(parse('evidence E1\nrule R1\nclaim C1 = R1 |> R1'), KEY),
    CheckError,
  );
  assert.throws(
    () => buildLedger(parse('evidence E1\nrule R1\nclaim C1 = E1 & R1'), KEY),
    /cannot combine rules/,
  );
  assert.throws(
    () => buildLedger(parse('evidence E1\nevidence E2\nclaim C1 = E1 requires E2'), KEY),
    /requires expects a claim/,
  );
  assert.throws(
    () => buildLedger(parse('evidence E1\nrule R1\nclaim C1 = E1'), KEY),
    /must be a claim expression/,
  );
});

test('verifyChain rejects tampered certificates, parents and types', () => {
  const ledger = buildLedger(parse(CHAIN_SCRIPT), KEY);
  verifyChain(ledger.commits, KEY);

  const flip = (hex) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);

  const badSig = ledger.commits.map((c) => ({ ...c }));
  badSig[1].cert = flip(badSig[1].cert);
  assert.throws(() => verifyChain(badSig, KEY), /signature mismatch/);

  const badParent = ledger.commits.map((c) => ({ ...c }));
  badParent[2].parent = flip(badParent[2].parent);
  assert.throws(() => verifyChain(badParent, KEY), /parent certificate mismatch/);

  const badType = ledger.commits.map((c) => ({ ...c }));
  badType[0].type = 'rule';
  assert.throws(() => verifyChain(badType, KEY), LedgerError);

  const wrongKey = ledger.commits.map((c) => ({ ...c }));
  assert.throws(() => verifyChain(wrongKey, 'other-key'), /signature mismatch/);
});
