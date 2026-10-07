import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { render, DEFAULT_MAX_STEPS } from '../src/index.js';
import { expectTemplateError } from './helpers.js';

test('loop iterations consume the step budget', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const error = expectTemplateError(
    () => render('{{#each items as x}}{{ x }}{{/each}}', { items }, { maxSteps: 10 }),
    'BUDGET_EXCEEDED',
  );
  ok(error.message.includes('10'));
});

test('loops within budget render fully', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const out = render('{{#each items as x}}{{ x }};{{/each}}', { items }, { maxSteps: 50 });
  equal(out.split(';').filter(Boolean).length, 50);
});

test('filter applications consume the step budget', () => {
  const template = `{{ name${' | upper'.repeat(20)} }}`;
  expectTemplateError(() => render(template, { name: 'a' }, { maxSteps: 5 }), 'BUDGET_EXCEEDED');
});

test('loops and filters share one budget', () => {
  const items = Array.from({ length: 8 }, (_, i) => `n${i}`);
  // 8 iterations + 8 filter applications = 16 steps.
  const out = render('{{#each items as x}}{{ x | upper }}{{/each}}', { items }, { maxSteps: 16 });
  equal(out, 'N0N1N2N3N4N5N6N7');
  expectTemplateError(
    () => render('{{#each items as x}}{{ x | upper }}{{/each}}', { items }, { maxSteps: 15 }),
    'BUDGET_EXCEEDED',
  );
});

test('the default budget bounds runaway loops', () => {
  const items = Array.from({ length: DEFAULT_MAX_STEPS + 1 }, () => 0);
  expectTemplateError(() => render('{{#each items as x}}{{/each}}', { items }), 'BUDGET_EXCEEDED');
});

test('budget errors carry the position of the loop or filter', () => {
  const items = [1, 2, 3];
  const error = expectTemplateError(
    () => render('header\n{{#each items as x}}{{ x }}{{/each}}', { items }, { maxSteps: 1 }),
    'BUDGET_EXCEEDED',
  );
  equal(error.position.line, 2);
  equal(error.position.column, 1);
});
