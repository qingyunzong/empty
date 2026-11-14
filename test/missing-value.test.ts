import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeField,
  normalizeRecord,
  restoreRecord,
  serializeEvidence,
  deserializeEvidence,
  type MappingRuleset,
} from '../index.js';

const ruleset: MappingRuleset = {
  version: '1.2.0',
  fields: {
    name: { type: 'string' },
    age: { type: 'integer', sentinels: [-999, -1] },
    score: { type: 'number', sentinels: [-999] },
    active: { type: 'boolean' },
    tags: { type: 'array' },
    profile: { type: 'object' },
    ssn: { type: 'string', redactedMarkers: ['***', '[REDACTED]'] },
    note: { type: 'string', emptyStringIsMissing: false },
    bucket: { type: 'array', emptyCollectionIsMissing: true },
  },
};

test('absent：键缺失与 undefined 值区分记录', () => {
  const missing = normalizeField({}, 'name', ruleset);
  assert.equal(missing.category, 'absent');
  assert.equal(missing.present, false);
  assert.equal(missing.evidence.ruleId, 'absent:key-missing');
  assert.deepEqual(missing.evidence.original, { form: 'absent-key' });

  const undef = normalizeField({ name: undefined }, 'name', ruleset);
  assert.equal(undef.category, 'absent');
  assert.equal(undef.evidence.ruleId, 'absent:undefined-value');
  assert.deepEqual(undef.evidence.original, { form: 'undefined-value' });
});

test('null：显式 null 归为 null 类别', () => {
  const r = normalizeField({ name: null }, 'name', ruleset);
  assert.equal(r.category, 'null');
  assert.equal(r.evidence.ruleId, 'null:explicit-null');
  assert.deepEqual(r.evidence.original, { form: 'value', raw: null });
});

test('empty：空白字符串归为 empty，保留原始空白表示', () => {
  const r = normalizeField({ name: '   ' }, 'name', ruleset);
  assert.equal(r.category, 'empty');
  assert.equal(r.evidence.ruleId, 'empty:blank-string');
  assert.deepEqual(r.evidence.original, { form: 'value', raw: '   ' });

  // schema 关闭后空串是合法值
  const kept = normalizeField({ note: '' }, 'note', ruleset);
  assert.equal(kept.category, 'present');
  assert.equal(kept.value, '');
});

test('nan：数字 NaN 归为 nan 类别', () => {
  const r = normalizeField({ score: NaN }, 'score', ruleset);
  assert.equal(r.category, 'nan');
  assert.equal(r.evidence.ruleId, 'nan:number-nan');
});

test('sentinel：命中 schema 哨兵值，记录 matchedToken', () => {
  const r = normalizeField({ age: -999 }, 'age', ruleset);
  assert.equal(r.category, 'sentinel');
  assert.equal(r.evidence.ruleId, 'sentinel:schema-match');
  assert.equal(r.evidence.matchedToken, -999);
  assert.deepEqual(r.evidence.original, { form: 'value', raw: -999 });
});

test('redacted：命中脱敏标记，优先于其他规则', () => {
  const r = normalizeField({ ssn: '[REDACTED]' }, 'ssn', ruleset);
  assert.equal(r.category, 'redacted');
  assert.equal(r.evidence.matchedToken, '[REDACTED]');
});

test('合法零值与空集合不当缺失', () => {
  const zero = normalizeField({ age: 0 }, 'age', ruleset);
  assert.equal(zero.category, 'present');
  assert.equal(zero.value, 0);

  const falsy = normalizeField({ active: false }, 'active', ruleset);
  assert.equal(falsy.category, 'present');
  assert.equal(falsy.value, false);

  const emptyArr = normalizeField({ tags: [] }, 'tags', ruleset);
  assert.equal(emptyArr.category, 'present');
  assert.deepEqual(emptyArr.value, []);

  const emptyObj = normalizeField({ profile: {} }, 'profile', ruleset);
  assert.equal(emptyObj.category, 'present');
  assert.deepEqual(emptyObj.value, {});

  // 显式开启后空集合才归为 empty
  const bucket = normalizeField({ bucket: [] }, 'bucket', ruleset);
  assert.equal(bucket.category, 'empty');
  assert.equal(bucket.evidence.ruleId, 'empty:empty-collection');
});

test('证据携带规则版本', () => {
  const r = normalizeField({ age: -1 }, 'age', ruleset);
  assert.equal(r.evidence.rulesetVersion, '1.2.0');
  assert.equal(r.evidence.field, 'age');
});

test('normalizeRecord + restoreRecord 无损回查', () => {
  const original: Record<string, unknown> = {
    name: 'alice',
    age: -999,
    score: NaN,
    active: false,
    tags: [],
    profile: {},
    ssn: '***',
    note: '',
    bucket: [],
    // name 字段的 absent 情形用另一条记录验证
  };
  const normalized = normalizeRecord(original, ruleset);
  const restored = restoreRecord(normalized);

  assert.equal(restored.name, 'alice');
  assert.equal(restored.age, -999);
  assert.ok(Number.isNaN(restored.score as number));
  assert.equal(restored.active, false);
  assert.deepEqual(restored.tags, []);
  assert.deepEqual(restored.profile, {});
  assert.equal(restored.ssn, '***');
  assert.equal(restored.note, '');
  assert.deepEqual(restored.bucket, []);
});

test('absent 键在回查后保持缺失', () => {
  const normalized = normalizeRecord({ age: 30 }, ruleset);
  const restored = restoreRecord(normalized);
  assert.equal(Object.prototype.hasOwnProperty.call(restored, 'name'), false);
  assert.equal(restored.age, 30);
});

test('证据 JSON 序列化后仍可无损还原 NaN', () => {
  const r = normalizeField({ score: NaN }, 'score', ruleset);
  const json = serializeEvidence(r.evidence);
  const parsed = deserializeEvidence(json);
  const restored = restoreRecord({ score: { ...r, evidence: parsed } });
  assert.ok(Number.isNaN(restored.score as number));
});

test('类型不匹配归为 absent:type-mismatch 且保留原值', () => {
  const r = normalizeField({ age: 'thirty' }, 'age', ruleset);
  assert.equal(r.category, 'absent');
  assert.equal(r.evidence.ruleId, 'absent:type-mismatch');
  assert.deepEqual(r.evidence.original, { form: 'value', raw: 'thirty' });
});
