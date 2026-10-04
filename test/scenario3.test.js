import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';
import { QueryError } from '../src/query.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../examples/scenario3/${name}`, import.meta.url), 'utf8'));

const engine = () => new Engine(load('catalog.json'), load('data.json'));

test('scenario 3: unknown column returns an error', () => {
  assert.throws(
    () => engine().explain(load('query-unknown-column.json')),
    (e) => e instanceof QueryError && e.message === 'unknown column: users.nope',
  );
});

test('scenario 3: nested aggregate returns an error', () => {
  assert.throws(
    () => engine().explain(load('query-nested-aggregate.json')),
    (e) => e instanceof QueryError && e.message === 'nested aggregate is not allowed',
  );
});
