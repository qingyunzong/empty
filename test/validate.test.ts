import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validate.js';
import type { SchemaDocument } from '../src/schema.js';

const listDoc: SchemaDocument = {
  definitions: {
    List: {
      type: 'object',
      properties: {
        value: { type: 'integer' },
        next: { $ref: 'List' },
      },
      required: ['value'],
    },
  },
  root: { $ref: 'List' },
};

test('integer: accepts integers, rejects everything else', () => {
  const doc: SchemaDocument = { root: { type: 'integer' } };
  assert.deepEqual(validate(42, doc), []);
  assert.deepEqual(validate(-7, doc), []);
  const errors = validate(4.2, doc);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'type');
  assert.equal(errors[0]?.path, '$');
  assert.equal(validate('1', doc)[0]?.code, 'type');
  assert.equal(validate(null, doc)[0]?.code, 'type');
});

test('object: required properties and nested paths', () => {
  const doc: SchemaDocument = {
    root: {
      type: 'object',
      properties: {
        name: { type: 'integer' },
        child: {
          type: 'object',
          properties: { leaf: { type: 'integer' } },
          required: ['leaf'],
        },
      },
      required: ['name'],
    },
  };
  assert.deepEqual(validate({ name: 1, child: { leaf: 2 } }, doc), []);
  const errors = validate({ child: {} }, doc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [
      ['$', 'required'],
      ['$.child', 'required'],
    ],
  );
  assert.match(errors[0]?.message ?? '', /"name"/);
  assert.match(errors[1]?.message ?? '', /"leaf"/);
});

test('array: items validated with index paths', () => {
  const doc: SchemaDocument = {
    root: { type: 'array', items: { type: 'integer' } },
  };
  assert.deepEqual(validate([1, 2, 3], doc), []);
  const errors = validate([1, 'x', null], doc);
  assert.deepEqual(
    errors.map((e) => e.path),
    ['$[1]', '$[2]'],
  );
  assert.equal(validate({}, doc)[0]?.code, 'type');
});

test('oneOf: exactly one matching branch passes', () => {
  const doc: SchemaDocument = {
    root: { oneOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }] },
  };
  assert.deepEqual(validate(5, doc), []);
  assert.deepEqual(validate([1, 2], doc), []);
});

test('oneOf: zero matching branches reports oneOf.none', () => {
  const doc: SchemaDocument = {
    root: { oneOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }] },
  };
  const errors = validate('nope', doc);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'oneOf.none');
  assert.equal(errors[0]?.path, '$');
});

test('oneOf: multiple matching branches report ambiguity with branch paths', () => {
  const doc: SchemaDocument = {
    root: {
      type: 'object',
      properties: {
        p: { oneOf: [{ type: 'integer' }, { type: 'integer' }, { type: 'array', items: { type: 'integer' } }] },
      },
    },
  };
  const errors = validate({ p: 3 }, doc);
  assert.equal(errors.length, 1);
  const error = errors[0];
  assert.equal(error?.code, 'oneOf.ambiguous');
  assert.equal(error?.path, '$.p');
  assert.deepEqual(error?.branches, ['#/oneOf/0', '#/oneOf/1']);
  assert.match(error?.message ?? '', /2 of 3/);
});

test('oneOf: ambiguity is reported at the oneOf location inside arrays', () => {
  const doc: SchemaDocument = {
    root: {
      type: 'array',
      items: { oneOf: [{ type: 'integer' }, { type: 'integer' }] },
    },
  };
  const errors = validate([1], doc);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'oneOf.ambiguous');
  assert.equal(errors[0]?.path, '$[0]');
  assert.deepEqual(errors[0]?.branches, ['#/oneOf/0', '#/oneOf/1']);
});

test('oneOf: a branch that is itself ambiguous counts as not matched', () => {
  const doc: SchemaDocument = {
    root: {
      oneOf: [
        { oneOf: [{ type: 'integer' }, { type: 'integer' }] },
        { type: 'array', items: { type: 'integer' } },
      ],
    },
  };
  // 1 makes the inner oneOf ambiguous, so branch 0 fails; branch 1 also
  // fails -> the outer oneOf reports oneOf.none, not ambiguity.
  const errors = validate(1, doc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [['$', 'oneOf.none']],
  );
});

test('recursive $ref schemas validate finite data of any depth', () => {
  assert.deepEqual(validate({ value: 1, next: { value: 2 } }, listDoc), []);
  const depth = 200_000;
  let node: Record<string, unknown> = { value: depth - 1 };
  for (let i = depth - 2; i >= 0; i -= 1) {
    node = { value: i, next: node };
  }
  assert.deepEqual(validate(node, listDoc), []);
});

test('recursive $ref reports errors deep inside the list', () => {
  const errors = validate({ value: 1, next: { value: 'x' } }, listDoc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [['$.next.value', 'type']],
  );
});

test('data cycles are rejected: object self-reference', () => {
  const node: Record<string, unknown> = { value: 1 };
  node.next = node;
  const errors = validate(node, listDoc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [['$.next', 'cycle']],
  );
});

test('data cycles are rejected: array containing itself', () => {
  const doc: SchemaDocument = {
    root: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  };
  const arr: unknown[] = [];
  arr.push(arr);
  const errors = validate(arr, doc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [['$[0]', 'cycle']],
  );
});

test('data cycles are rejected: mutual references at depth', () => {
  const a: Record<string, unknown> = { value: 1 };
  const b: Record<string, unknown> = { value: 2, next: a };
  a.next = b;
  const errors = validate(a, listDoc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [['$.next.next', 'cycle']],
  );
});

test('shared (DAG) references that are not cyclic are accepted', () => {
  const shared = { value: 9 };
  const doc: SchemaDocument = {
    root: {
      type: 'object',
      properties: { left: listDoc.root, right: listDoc.root },
    },
    definitions: listDoc.definitions,
  };
  assert.deepEqual(validate({ left: shared, right: shared }, doc), []);
});

test('unresolved and self-serving references are schema errors, not hangs', () => {
  const unresolved = validate(1, { root: { $ref: 'Missing' } });
  assert.deepEqual(
    unresolved.map((e) => [e.path, e.code]),
    [['$', 'ref.unresolved']],
  );
  const loop = validate(1, {
    root: { $ref: 'A' },
    definitions: { A: { $ref: 'B' }, B: { $ref: 'A' } },
  });
  assert.deepEqual(
    loop.map((e) => [e.path, e.code]),
    [['$', 'ref.loop']],
  );
});

test('oneOf/$ref cycles that never consume data terminate instead of hanging', () => {
  const doc: SchemaDocument = {
    definitions: {
      R: { oneOf: [{ $ref: 'R' }, { type: 'integer' }] },
    },
    root: { $ref: 'R' },
  };
  // The $ref branch recurses through oneOf/$ref without inspecting the data;
  // the repetition is cut off as a non-productive branch. For 5 the cut-off
  // branch still succeeds via its own integer arm, so both outer branches
  // match and the result is an ambiguity error.
  const ambiguous = validate(5, doc);
  assert.deepEqual(
    ambiguous.map((e) => [e.path, e.code]),
    [['$', 'oneOf.ambiguous']],
  );
  assert.deepEqual(ambiguous[0]?.branches, ['#/oneOf/0', '#/oneOf/1']);
  const errors = validate('x', doc);
  assert.deepEqual(
    errors.map((e) => [e.path, e.code]),
    [['$', 'oneOf.none']],
  );
});

test('errors are sorted by UTF-8 byte order of paths, not UTF-16 order', () => {
  const doc: SchemaDocument = {
    root: {
      type: 'object',
      properties: {
        '￿': { type: 'integer' },
        '𐀀': { type: 'integer' },
        z: { type: 'integer' },
        a: { type: 'integer' },
      },
    },
  };
  const errors = validate({ '￿': 'x', '𐀀': 'x', z: 'x', a: 'x' }, doc);
  const paths = errors.map((e) => e.path);
  // UTF-8 bytes: $.a < $.z < $["￿"](EF BF BF) < $["𐀀"](F0 90 80 80).
  // UTF-16 code units would place "𐀀" (surrogates D800..) before "￿" (FFFF).
  assert.deepEqual(paths, ['$.a', '$.z', '$["￿"]', '$["𐀀"]']);
  const utf16Order = [...paths].sort();
  assert.notEqual(utf16Order.join(), paths.join());
});

test('byte order applies to array indices as raw text ($[10] before $[2])', () => {
  const doc: SchemaDocument = {
    root: { type: 'array', items: { type: 'integer' } },
  };
  const data = Array.from({ length: 12 }, () => 'bad');
  const paths = validate(data, doc).map((e) => e.path);
  // '$[10]' < '$[1]' bytewise because '0' (0x30) < ']' (0x5D).
  assert.deepEqual(paths.slice(0, 4), ['$[0]', '$[10]', '$[11]', '$[1]']);
  assert.equal(paths[paths.length - 1], '$[9]');
});
