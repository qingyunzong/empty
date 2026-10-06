import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleStore, Journal } from '../src/store.js';
import { parseSamples } from '../src/samples.js';
import { IllegalRollbackError, StoreError } from '../src/errors.js';

const V1 = `{"type":"batch","id":"B-1","size":100}
{"id":"s1","defects":0}
{"id":"s2","defects":1,"level":"major"}
`;
// corrected label: s2 defects 1 -> 0
const V2 = `{"type":"batch","id":"B-1","size":100}
{"id":"s1","defects":0}
{"id":"s2","defects":0}
`;

test('correction produces a new version; identical content is idempotent', () => {
  const store = SampleStore.empty();
  const c1 = store.commit(parseSamples(V1));
  assert.equal(c1.version.version, 1);
  assert.equal(c1.created, true);
  const again = store.commit(parseSamples(V1));
  assert.equal(again.version.version, 1);
  assert.equal(again.created, false);
  const c2 = store.commit(parseSamples(V2));
  assert.equal(c2.version.version, 2);
  assert.notEqual(c2.version.hash, c1.version.hash);
  // old version retained, traceable
  assert.equal(store.versions.length, 2);
  assert.equal(store.versions[0].samples[1].defects, 1);
});

test('rollback is only legal for an uncommitted draft', () => {
  const store = SampleStore.empty();
  store.commit(parseSamples(V1));
  assert.throws(() => store.rollback(), (err) => {
    assert.ok(err instanceof IllegalRollbackError);
    assert.match(err.message, /illegal rollback/);
    return true;
  });
  store.beginDraft(parseSamples(V2));
  const discarded = store.rollback();
  assert.equal(discarded.based_on, 1);
  assert.equal(store.draft, null);
  assert.equal(store.versions.length, 1); // committed version untouched
});

test('committing a draft creates a version; double draft is rejected', () => {
  const store = SampleStore.empty();
  store.commit(parseSamples(V1));
  store.beginDraft(parseSamples(V2));
  assert.throws(() => store.beginDraft(parseSamples(V2)), StoreError);
  const { version } = store.commitDraft();
  assert.equal(version.version, 2);
  assert.equal(store.draft, null);
  assert.throws(() => store.rollback(), IllegalRollbackError);
});

test('journal supersedes old certs without deleting them', () => {
  const j = new Journal();
  j.append({ certHash: 'sha256:aaa', ruleHash: 'sha256:r1', sampleVersion: 1, sampleHash: 'sha256:s1', decision: 'ACCEPT' });
  assert.equal(j.statusOf('sha256:aaa'), 'ACTIVE');
  const rec2 = j.append({ certHash: 'sha256:bbb', ruleHash: 'sha256:r1', sampleVersion: 2, sampleHash: 'sha256:s2', decision: 'REJECT' });
  assert.deepEqual(rec2.supersedes, ['sha256:aaa']);
  assert.equal(j.statusOf('sha256:aaa'), 'SUPERSEDED');
  assert.equal(j.statusOf('sha256:bbb'), 'ACTIVE');
  assert.equal(j.statusOf('sha256:zzz'), 'UNKNOWN');
  // old record still present
  assert.equal(j.records.length, 2);
  // certs of a different rule are not superseded
  j.append({ certHash: 'sha256:ccc', ruleHash: 'sha256:r2', sampleVersion: 1, sampleHash: 'sha256:s1', decision: 'CONTINUE' });
  assert.equal(j.statusOf('sha256:bbb'), 'ACTIVE');
});

test('journal round-trips through serialization', () => {
  const j = new Journal();
  j.append({ certHash: 'sha256:aaa', ruleHash: 'sha256:r1', sampleVersion: 1, sampleHash: 'sha256:s1', decision: 'ACCEPT' });
  const j2 = Journal.parse(j.serialize());
  assert.equal(j2.statusOf('sha256:aaa'), 'ACTIVE');
});
