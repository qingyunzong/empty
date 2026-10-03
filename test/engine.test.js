'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EvidenceEngine, QueryBudgetError, QuerySchemaError, QueryTypeError,
} = require('../src');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'schema.json'), 'utf8'));
const records = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'records.json'), 'utf8'));

const makeEngine = () => new EvidenceEngine({ schema, records });
const handFilter = (fn) => records.filter(fn).map((r) => r.id);

test('boolean combination matches hand-filtered ids', () => {
  const engine = makeEngine();
  const cert = engine.query('source:email and severity >= 3');
  assert.deepStrictEqual(
    cert.hits,
    handFilter((r) => r.source === 'email' && r.severity >= 3)
  );
  assert.deepStrictEqual(cert.hits, ['EV-001', 'EV-005']);
});

test('or, not and parentheses match hand-filtered ids', () => {
  const engine = makeEngine();
  assert.deepStrictEqual(
    engine.query('source:email or source:network').hits,
    handFilter((r) => r.source === 'email' || r.source === 'network')
  );
  assert.deepStrictEqual(
    engine.query('not resolved = false').hits,
    handFilter((r) => !(r.resolved === false))
  );
  assert.deepStrictEqual(
    engine.query('(source:email or source:endpoint) and not resolved = true').hits,
    handFilter((r) => (r.source === 'email' || r.source === 'endpoint') && r.resolved !== true)
  );
});

test('date range and regex predicates match hand-filtered ids', () => {
  const engine = makeEngine();
  assert.deepStrictEqual(
    engine.query('date >= 2024-02-01 and date < 2024-03-01').hits,
    handFilter((r) => r.date >= '2024-02-01' && r.date < '2024-03-01')
  );
  assert.deepStrictEqual(
    engine.query('notes:/link/').hits,
    handFilter((r) => /link/.test(r.notes))
  );
  assert.deepStrictEqual(
    engine.query('title:"phishing"').hits,
    handFilter((r) => r.title.toLowerCase().includes('phishing'))
  );
});

test('full-text bare word searches all string fields', () => {
  const engine = makeEngine();
  const stringFields = ['id', 'title', 'source', 'notes'];
  assert.deepStrictEqual(
    engine.query('network').hits,
    handFilter((r) => stringFields.some((f) => r[f].toLowerCase().includes('network')))
  );
});

test('unknown field and string < comparison are compile-time errors', () => {
  const engine = makeEngine();
  assert.throws(() => engine.query('nosuchfield:x'), QuerySchemaError);
  assert.throws(() => engine.query('title < "abc"'), QueryTypeError);
});

test('budget below enumeration cost fails with no partial hits', () => {
  const engine = makeEngine();
  const full = engine.query('source:email');
  assert.strictEqual(full.hits.length, 3);
  assert.strictEqual(full.instructions, records.length * 3);
  const failing = makeEngine();
  assert.throws(
    () => failing.query('source:email', full.instructions - 1),
    QueryBudgetError
  );
  assert.strictEqual(failing.versions.length, 0);
  assert.strictEqual(failing.current(), null);
});

test('undo and redo move between versions', () => {
  const engine = makeEngine();
  const a = engine.query('source:email');
  const b = engine.query('source:network');
  const c = engine.query('severity >= 5');
  assert.strictEqual(engine.current().version, 3);
  engine.undo();
  assert.deepStrictEqual(engine.current().hits, b.hits);
  engine.undo();
  assert.deepStrictEqual(engine.current().hits, a.hits);
  engine.undo();
  assert.deepStrictEqual(engine.current().hits, a.hits);
  engine.redo();
  assert.deepStrictEqual(engine.current().hits, b.hits);
  engine.redo();
  assert.deepStrictEqual(engine.current().hits, c.hits);
  engine.redo();
  assert.deepStrictEqual(engine.current().hits, c.hits);
});

test('new query truncates redo history', () => {
  const engine = makeEngine();
  engine.query('source:email');
  engine.query('source:network');
  engine.undo();
  const replacement = engine.query('severity >= 5');
  assert.strictEqual(replacement.version, 2);
  assert.strictEqual(engine.versions.length, 2);
  engine.redo();
  assert.strictEqual(engine.current().version, 2);
});

test('certificate contains normalized ast, schema hash, budget and instructions', () => {
  const engine = makeEngine();
  const cert = engine.query('source:email and severity >= 3', 5000);
  assert.strictEqual(cert.version, 1);
  assert.strictEqual(cert.schemaHash, engine.schemaHash);
  assert.strictEqual(cert.schemaHash.length, 64);
  assert.strictEqual(cert.budget, 5000);
  assert.strictEqual(cert.instructions, records.length * 7);
  assert.deepStrictEqual(Object.keys(cert.ast).sort(), ['left', 'op', 'right', 'type']);
  assert.strictEqual(cert.recordCount, records.length);
  assert.deepStrictEqual(cert.hits, ['EV-001', 'EV-005']);
});

test('state round-trip preserves versions and cursor', () => {
  const engine = makeEngine();
  engine.query('source:email');
  engine.query('source:network');
  engine.undo();
  const restored = EvidenceEngine.fromState(engine.toJSON(), { schema, records });
  assert.strictEqual(restored.cursor, 0);
  assert.strictEqual(restored.versions.length, 2);
  assert.deepStrictEqual(restored.current().hits, ['EV-001', 'EV-005', 'EV-008']);
});
