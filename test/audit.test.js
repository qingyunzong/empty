import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/engine.js';
import { verifyChain, rollback } from '../src/ledger.js';
import { InputError } from '../src/errors.js';

const RULE = `
rule "audit" version 1 {
  param sampled: quantity
  param defects: quantity
  const max_defects: quantity = 1
  const min_sample: quantity = 2
  when defects > max_defects => REJECT
  when sampled >= min_sample and defects <= max_defects => ACCEPT
  otherwise => CONTINUE
}
`;

const SAMPLES_V1 = `
{"type":"sample","id":"S1","defects":0}
{"type":"sample","id":"S2","defects":2}
`;

const SAMPLES_V2 = `${SAMPLES_V1}{"type":"correction","id":"S2","defects":0,"reason":"label misread"}\n`;

test('correction creates a new version; old cert is SUPERSEDED but verifiable', () => {
  const first = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V1, samplesFilename: 's.jsonl',
    chain: null,
  });
  assert.equal(first.chain.certs.length, 1);
  assert.equal(first.chain.certs[0].decision, 'REJECT');
  assert.equal(first.chain.certs[0].status, 'ACTIVE');

  const second = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V2, samplesFilename: 's.jsonl',
    chain: first.chain,
  });
  const [oldCert, newCert] = second.chain.certs;
  assert.equal(second.chain.certs.length, 2);
  assert.equal(oldCert.status, 'SUPERSEDED');
  assert.equal(oldCert.decision, 'REJECT');
  assert.equal(newCert.status, 'ACTIVE');
  assert.equal(newCert.decision, 'ACCEPT');
  assert.equal(newCert.version, 2);
  assert.notEqual(oldCert.sampleHash, newCert.sampleHash);
  assert.equal(newCert.prevHash, oldCert.certHash);

  const result = verifyChain(second.chain);
  assert.ok(result.ok, result.errors.join('; '));
  assert.deepEqual(
    result.results.map((r) => [r.version, r.status, r.ok]),
    [[1, 'SUPERSEDED', true], [2, 'ACTIVE', true]],
  );
});

test('certificates carry rule hash, sample hash and version', () => {
  const { chain } = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V1, samplesFilename: 's.jsonl',
    chain: null,
  });
  const cert = chain.certs[0];
  assert.match(cert.ruleHash, /^[0-9a-f]{64}$/);
  assert.match(cert.sampleHash, /^[0-9a-f]{64}$/);
  assert.match(cert.certHash, /^[0-9a-f]{64}$/);
  assert.equal(cert.version, 1);
});

test('illegal rollback to a published decision is rejected', () => {
  const { chain } = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V2, samplesFilename: 's.jsonl',
    chain: null,
  });
  assert.throws(
    () => rollback(chain, 1),
    (err) => err instanceof InputError && /illegal rollback/.test(err.message),
  );
  assert.throws(() => rollback(chain, 0), /illegal rollback/);
  // chain untouched
  assert.equal(chain.certs.length, 2);
});

test('rollback of uncommitted drafts is legal', () => {
  const { chain } = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V1, samplesFilename: 's.jsonl',
    chain: null,
  });
  decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V2, samplesFilename: 's.jsonl',
    chain, draft: true,
  });
  assert.equal(chain.certs.length, 2);
  assert.equal(chain.certs[1].status, 'DRAFT');
  assert.equal(chain.certs[0].status, 'ACTIVE');

  const dropped = rollback(chain, 1);
  assert.equal(dropped, 1);
  assert.equal(chain.certs.length, 1);
  assert.equal(chain.certs[0].status, 'ACTIVE');
  assert.ok(verifyChain(chain).ok);
});

test('tampered certificates fail verification', () => {
  const { chain } = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V2, samplesFilename: 's.jsonl',
    chain: null,
  });
  chain.certs[0].decision = 'ACCEPT';
  const result = verifyChain(chain);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /certificate hash mismatch/.test(e)));
});

test('diverging sample history is rejected', () => {
  const { chain } = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V1, samplesFilename: 's.jsonl',
    chain: null,
  });
  const tampered = SAMPLES_V1.replace('"defects":2', '"defects":1');
  assert.throws(
    () => decide({
      ruleSource: RULE, ruleFilename: 'r.dsl',
      samplesText: tampered, samplesFilename: 's.jsonl',
      chain,
    }),
    /sample history diverges at version 1/,
  );
});

test('rule hash mismatch against existing chain is rejected', () => {
  const { chain } = decide({
    ruleSource: RULE, ruleFilename: 'r.dsl',
    samplesText: SAMPLES_V1, samplesFilename: 's.jsonl',
    chain: null,
  });
  assert.throws(
    () => decide({
      ruleSource: RULE.replace('version 1', 'version 2'), ruleFilename: 'r.dsl',
      samplesText: SAMPLES_V1, samplesFilename: 's.jsonl',
      chain,
    }),
    /rule hash mismatch/,
  );
});
