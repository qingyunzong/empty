'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parse,
  elaborate,
  compile,
  verifyDocument,
  Session,
} = require('../src/index');

const KEY = 'test-hmac-key';
const { run: runCli } = require('../cli.js');

const CHAIN_SOURCE = `
evidence E1
evidence E2
evidence E3
rule Step
claim C1 = E1 |> Step
claim C2 = (C1 & E2) |> Step
claim C3 = (C2 & E3) |> Step
`;

test('acceptance 1: three-evidence chain verifies, transitive deps match manual enumeration', () => {
  const doc = compile(CHAIN_SOURCE, KEY);
  const session = new Session(doc, KEY);
  const verdict = session.verdict();
  assert.equal(verdict.valid, true);
  // Manually enumerated transitive evidence dependencies.
  assert.deepEqual(verdict.claims.C1.deps, ['E1']);
  assert.deepEqual(verdict.claims.C2.deps, ['E1', 'E2']);
  assert.deepEqual(verdict.claims.C3.deps, ['E1', 'E2', 'E3']);
  assert.ok(Object.values(verdict.claims).every((c) => c.valid));
});

test('acceptance 2: revoking middle evidence E2 invalidates C2 and C3, C1 stays valid', () => {
  const doc = compile(CHAIN_SOURCE, KEY);
  const session = new Session(doc, KEY);
  session.revoke('E2');
  const verdict = session.verdict();
  assert.equal(verdict.valid, false);
  assert.equal(verdict.claims.C1.valid, true);
  assert.equal(verdict.claims.C2.valid, false);
  assert.equal(verdict.claims.C3.valid, false);
  assert.deepEqual(verdict.claims.C2.revokedDeps, ['E2']);
  assert.deepEqual(verdict.claims.C3.revokedDeps, ['E2']);
});

test('undo restores revoked evidence; new operation clears redo', () => {
  const doc = compile(CHAIN_SOURCE, KEY);
  const session = new Session(doc, KEY);
  session.revoke('E2');
  assert.equal(session.verdict().claims.C3.valid, false);
  session.undo();
  assert.equal(session.verdict().valid, true);
  session.redo();
  assert.equal(session.verdict().claims.C3.valid, false);
  session.undo();
  session.revoke('E1'); // new operation clears the redo stack
  assert.throws(() => session.redo(), /nothing to redo/);
  const verdict = session.verdict();
  assert.equal(verdict.claims.C1.valid, false);
  assert.equal(verdict.claims.C2.valid, false);
  assert.equal(verdict.claims.C3.valid, false);
});

test('acceptance 3a: alias escaping its scope is rejected', () => {
  const source = `
evidence A
rule R
{
  alias Inner = A
  claim Ok = Inner |> R
}
claim Bad = Inner |> R
`;
  assert.throws(() => elaborate(parse(source)), /unknown identifier 'Inner'/);
});

test('acceptance 3b: tampered signature is rejected', () => {
  const doc = compile(CHAIN_SOURCE, KEY);
  const tampered = JSON.parse(JSON.stringify(doc));
  tampered.commits[4].cert = tampered.commits[4].cert.replace(/^../, '00');
  assert.throws(() => verifyDocument(tampered, KEY), /invalid certificate signature/);
  // Wrong key is also rejected.
  assert.throws(() => verifyDocument(doc, 'wrong-key'), /invalid certificate signature/);
});

test('acceptance 3c: CLI exits 1 on scope escape and on tampered signature', () => {
  const badScope = runCli(['verify', path.join(__dirname, '..', 'examples', 'bad-scope.ev'), '--key', KEY]);
  assert.equal(badScope.code, 1);
  assert.match(badScope.stderr, /unknown identifier 'InnerAlias'/);

  const doc = compile(CHAIN_SOURCE, KEY);
  doc.commits[3].cert = 'ff'.repeat(32);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evchain-')), 'tampered.json');
  fs.writeFileSync(tmp, JSON.stringify(doc));
  const tampered = runCli(['verify-cert', tmp, '--key', KEY]);
  assert.equal(tampered.code, 1);
  assert.match(tampered.stderr, /invalid certificate signature/);
});

test('CLI verify prints JSON verdict with exit 0; --revoke marks downstream claims invalid', () => {
  const chainFile = path.join(__dirname, '..', 'examples', 'chain.ev');
  const ok = runCli(['verify', chainFile, '--key', KEY]);
  assert.equal(ok.code, 0);
  const verdict = JSON.parse(ok.stdout);
  assert.equal(verdict.valid, true);
  assert.deepEqual(verdict.claims.C3.deps, ['E1', 'E2', 'E3']);

  const revoked = runCli(['verify', chainFile, '--key', KEY, '--revoke', 'E2']);
  assert.equal(revoked.code, 1);
  const revokedVerdict = JSON.parse(revoked.stdout);
  assert.equal(revokedVerdict.claims.C1.valid, true);
  assert.equal(revokedVerdict.claims.C2.valid, false);
  assert.equal(revokedVerdict.claims.C3.valid, false);
});

test('nested scopes: aliases visible in own block and children, duplicates rejected', () => {
  const scoped = fs.readFileSync(path.join(__dirname, '..', 'examples', 'scopes.ev'), 'utf8');
  const doc = compile(scoped, KEY);
  const session = new Session(doc, KEY);
  assert.equal(session.verdict().valid, true);

  const duplicate = `
evidence A
alias X = A
alias X = A
`;
  assert.throws(() => elaborate(parse(duplicate)), /duplicate declaration of 'X'/);
});

test('static types: rule misuse and requires typing are rejected', () => {
  assert.throws(
    () => elaborate(parse('evidence A\nrule R\nclaim C = R & A\n')),
    /operands of '&' must be evidence or claim/,
  );
  assert.throws(
    () => elaborate(parse('evidence A\nclaim C = A requires A\n')),
    /left operand of 'requires' must be a claim/,
  );
  const ok = `
evidence A
rule R
claim C = A |> R
claim D = C requires A
`;
  const session = new Session(compile(ok, KEY), KEY);
  assert.equal(session.verdict().valid, true);
});

test('parent-link tampering breaks the certificate chain', () => {
  const doc = compile(CHAIN_SOURCE, KEY);
  const tampered = JSON.parse(JSON.stringify(doc));
  tampered.commits[2].parent = 'ab'.repeat(32);
  assert.throws(() => verifyDocument(tampered, KEY), /parent link mismatch|invalid certificate/);
});

test('cli smoke: certify writes a verifiable document', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evchain-')), 'doc.json');
  const chainFile = path.join(__dirname, '..', 'examples', 'chain.ev');
  const certified = runCli(['certify', chainFile, '--key', KEY, '--out', tmp]);
  assert.equal(certified.code, 0);
  const verified = runCli(['verify-cert', tmp, '--key', KEY]);
  assert.equal(verified.code, 0);
  assert.equal(JSON.parse(verified.stdout).valid, true);
});
