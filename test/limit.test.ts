import test from 'node:test';
import assert from 'node:assert/strict';
import { render, interpret, ExpansionLimitError } from '../src/index.js';

test('output within the limit renders normally', () => {
  const result = render('{{a}}{{b}}', { a: 'xy', b: 'zt' }, { maxOutputLength: 4 });
  assert.equal(result.output, 'xyzt');
});

test('exceeding the limit fails the whole render with no partial result', () => {
  let result: unknown = 'sentinel';
  try {
    result = render('{{a}}{{b}}', { a: 'xy', b: 'zt' }, { maxOutputLength: 3 });
  } catch (err) {
    assert.ok(err instanceof ExpansionLimitError);
    assert.equal((err as ExpansionLimitError).limit, 3);
    result = undefined;
  }
  assert.equal(result, undefined, 'render must fail atomically and produce nothing');
});

test('limit applies across loop iterations', () => {
  const template = '{{#each items}}{{this}}{{/each}}';
  const data = { items: ['ab', 'cd', 'ef'] };
  assert.equal(render(template, data, { maxOutputLength: 6 }).output, 'abcdef');
  assert.throws(() => render(template, data, { maxOutputLength: 5 }), ExpansionLimitError);
});

test('interpreter agrees on limit failures', () => {
  const data = { a: 'xy', b: 'zt' };
  assert.equal(interpret('{{a}}{{b}}', data, 4), 'xyzt');
  assert.throws(() => interpret('{{a}}{{b}}', data, 3), ExpansionLimitError);
});
