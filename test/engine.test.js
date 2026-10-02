'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EvidenceEngine, sha256, stableStringify } = require('../src/engine');
const { BudgetExceededError, QueryTypeError } = require('../src/errors');

const schema = {
  fields: {
    title: 'string',
    status: 'string',
    assignee: 'string',
    severity: 'number',
    created: 'date',
    verified: 'boolean',
  },
};

const records = [
  { id: 'EV-001', title: 'Phishing email header', status: 'open', assignee: 'alice', severity: 4, created: '2024-01-15', verified: true },
  { id: 'EV-002', title: 'Malware sandbox trace', status: 'closed', assignee: 'bob', severity: 5, created: '2024-02-03', verified: true },
  { id: 'EV-003', title: 'Suspicious login log', status: 'open', assignee: 'alice', severity: 2, created: '2024-02-20', verified: false },
  { id: 'EV-004', title: 'Ransomware note sample', status: 'open', assignee: 'carol', severity: 5, created: '2024-03-01', verified: false },
  { id: 'EV-005', title: 'Phishing kit archive', status: 'closed', assignee: 'bob', severity: 3, created: '2024-03-12', verified: true },
  { id: 'EV-006', title: 'DNS tunneling capture', status: 'open', assignee: 'carol', severity: 3, created: '2024-04-08', verified: true },
];

const makeEngine = (budget = 10000) => new EvidenceEngine({ schema, records, budget });

test('boolean combination matches hand-filtered ids', () => {
  const engine = makeEngine();
  const q = '(status:open and severity>=3) or (title:phishing and not verified:false)';
  const { hits } = engine.run(q);

  const expected = records
    .filter((r) =>
      (r.status === 'open' && r.severity >= 3) ||
      (r.title.toLowerCase().includes('phishing') && !(r.verified === false))
    )
    .map((r) => r.id);
  assert.deepEqual(hits, expected);
  assert.deepEqual(hits, ['EV-001', 'EV-004', 'EV-005', 'EV-006']);
});

test('full-text term, phrase and regex search string fields', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.run('phishing').hits, ['EV-001', 'EV-005']);
  assert.deepEqual(engine.run('"kit archive"').hits, ['EV-005']);
  assert.deepEqual(engine.run('title:/^dns/i').hits, ['EV-006']);
});

test('date and number comparisons', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.run('created>=2024-03-01 and created<2024-04-01').hits, ['EV-004', 'EV-005']);
  assert.deepEqual(engine.run('severity=5').hits, ['EV-002', 'EV-004']);
  assert.deepEqual(engine.run('severity!=5 and status:open').hits, ['EV-001', 'EV-003', 'EV-006']);
});

test('budget below required instructions fails with no partial hits and unchanged state', () => {
  const engine = makeEngine();
  const query = 'status:open or severity>=4';
  const first = engine.run(query);
  const needed = first.certificate.instructions;
  assert.ok(needed > 0);

  const versionsBefore = engine.versions.length;
  const currentBefore = engine.current;
  assert.throws(
    () => engine.run(query, { budget: needed - 1 }),
    BudgetExceededError
  );
  assert.equal(engine.versions.length, versionsBefore);
  assert.equal(engine.current, currentBefore);
  assert.deepEqual(engine.currentVersion().hits, first.hits);
});

test('undo and redo switch between query versions', () => {
  const engine = makeEngine();
  engine.run('status:open');
  engine.run('status:closed');
  assert.deepEqual(engine.currentVersion().hits, ['EV-002', 'EV-005']);

  engine.undo();
  assert.deepEqual(engine.currentVersion().hits, ['EV-001', 'EV-003', 'EV-004', 'EV-006']);
  engine.redo();
  assert.deepEqual(engine.currentVersion().hits, ['EV-002', 'EV-005']);

  // A new query after undo truncates the redo tail.
  engine.undo();
  engine.run('verified:false');
  assert.equal(engine.versions.length, 2);
  assert.deepEqual(engine.currentVersion().hits, ['EV-003', 'EV-004']);
  engine.redo(); // nothing to redo
  assert.deepEqual(engine.currentVersion().hits, ['EV-003', 'EV-004']);
});

test('certificate carries normalized AST, schema hash, budget and instruction count', () => {
  const engine = makeEngine(500);
  const { certificate } = engine.run('zzz and qqq and qqq');
  assert.equal(certificate.version, 1);
  assert.equal(certificate.normalizedAst, '(and (text w"qqq") (text w"zzz"))');
  assert.equal(certificate.astHash, sha256('(and (text w"qqq") (text w"zzz"))'));
  assert.equal(certificate.schemaHash, sha256(stableStringify(schema)));
  assert.equal(certificate.budget, 500);
  assert.equal(certificate.instructions, records.length * 3);
  assert.deepEqual(certificate.hits, []);
});

test('compile-time errors leave engine state unchanged', () => {
  const engine = makeEngine();
  engine.run('status:open');
  const before = engine.versions.length;
  assert.throws(() => engine.run('nosuchfield:1'), QueryTypeError);
  assert.equal(engine.versions.length, before);
});

test('engine state round-trips through JSON', () => {
  const engine = makeEngine(777);
  engine.run('status:open');
  engine.run('severity>3');
  engine.undo();
  const restored = EvidenceEngine.fromJSON(JSON.parse(JSON.stringify(engine)));
  assert.equal(restored.budget, 777);
  assert.equal(restored.current, engine.current);
  assert.deepEqual(restored.currentVersion(), engine.currentVersion());
});
