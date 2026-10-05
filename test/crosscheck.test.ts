import test from 'node:test';
import assert from 'node:assert/strict';
import { render, interpret, ExpansionLimitError } from '../src/index.js';
import { assertMapping } from './helpers.js';

const DATA = {
  user: { name: 'Ada', vip: true, email: 'ada@example.com' },
  company: { name: 'ACME', tiers: ['gold', 'silver'] },
  items: [
    { name: 'Book', qty: 2, tags: ['new', 'sale'] },
    { name: 'Pen', qty: 5, tags: [] },
  ],
  count: 3,
  note: 'Use {{literal}} braces & <b>html</b>',
  empty: '',
  zero: 0,
  missingList: null,
};

const CASES: string[] = [
  'Hello {{user.name}}!',
  '{{#if user.vip}}Dear VIP {{user.name}}{{else}}Dear {{user.name}}{{/if}}',
  '{{#each items}}{{this.qty}}x {{this.name}} ({{@index}})\n{{/each}}',
  '{{#each company.tiers}}tier: {{this}};{{/each}}',
  '{{#each items}}{{#each this.tags}}#{{this}} {{/each}}|{{/each}}',
  '{{! header }}Hi {{user.name}}{{#if count}} ({{count}}){{/if}}',
  'Note: {{note}}',
  '{{#if empty}}shown{{else}}hidden{{/if}}{{#if zero}}z{{else}}nz{{/if}}',
  '{{#each missingList}}never{{/each}}done',
  '{{#each items}}{{user.name}} sells {{this.name}} for {{company.name}};{{/each}}',
];

test('interpreter agrees with the renderer on fixed cases', () => {
  for (const template of CASES) {
    const result = render(template, DATA);
    assert.equal(result.output, interpret(template, DATA), `output mismatch for: ${template}`);
    assertMapping(template, DATA, result);
  }
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  vars: string[];
  conds: string[];
  arrays: Array<{ path: string; elem: 'object' | 'string' }>;
}

const ROOT_CTX: Ctx = {
  vars: ['user.name', 'user.email', 'company.name', 'count', 'note', 'empty', 'zero'],
  conds: ['user.vip', 'count', 'empty', 'zero', 'items', 'company.tiers'],
  arrays: [
    { path: 'items', elem: 'object' },
    { path: 'company.tiers', elem: 'string' },
    { path: 'missingList', elem: 'string' },
  ],
};

const ITEM_CTX: Ctx = {
  vars: ['this.name', 'this.qty', '@index', 'user.name', 'company.name'],
  conds: ['this.qty', 'this.tags', 'user.vip'],
  arrays: [{ path: 'this.tags', elem: 'string' }],
};

const STRING_CTX: Ctx = {
  vars: ['this', '@index', 'user.name'],
  conds: ['this'],
  arrays: [],
};

const WORDS = ['Hello', 'dear', 'Team', 'ACME', '=', '-', '*', '}', '}}', '%', '&', '<b>', '\n', ' '];

function pick<T>(rand: () => number, list: T[]): T {
  return list[Math.floor(rand() * list.length)];
}

function genTemplate(rand: () => number, ctx: Ctx, depth: number): string {
  const pieces = 1 + Math.floor(rand() * 5);
  let out = '';
  for (let i = 0; i < pieces; i++) {
    const roll = rand();
    if (roll < 0.35) {
      out += pick(rand, WORDS);
    } else if (roll < 0.55) {
      out += `{{${pick(rand, ctx.vars)}}}`;
    } else if (roll < 0.62) {
      out += '{{! comment }}';
    } else if (roll < 0.8 && depth < 2) {
      out += `{{#if ${pick(rand, ctx.conds)}}}${genTemplate(rand, ctx, depth + 1)}`;
      if (rand() < 0.5) out += `{{else}}${genTemplate(rand, ctx, depth + 1)}`;
      out += '{{/if}}';
    } else if (ctx.arrays.length > 0 && depth < 2) {
      const arr = pick(rand, ctx.arrays);
      const childCtx = arr.elem === 'object' ? ITEM_CTX : STRING_CTX;
      out += `{{#each ${arr.path}}}${genTemplate(rand, childCtx, depth + 1)}{{/each}}`;
    } else {
      out += pick(rand, WORDS);
    }
  }
  return out;
}

test('interpreter cross-checks renderer and mapping on generated templates', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = mulberry32(seed);
    const template = genTemplate(rand, ROOT_CTX, 0);
    const result = render(template, DATA);
    assert.equal(result.output, interpret(template, DATA), `output mismatch for seed ${seed}`);
    assertMapping(template, DATA, result);
  }
});

test('interpreter agrees on expansion limit failures', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = mulberry32(1000 + seed);
    const template = genTemplate(rand, ROOT_CTX, 0);
    const full = render(template, DATA).output;
    const limit = Math.floor(rand() * (full.length + 3));
    let renderThrew = false;
    let interpretThrew = false;
    try {
      const result = render(template, DATA, { maxOutputLength: limit });
      assert.ok(result.output.length <= limit);
    } catch (err) {
      assert.ok(err instanceof ExpansionLimitError);
      renderThrew = true;
    }
    try {
      interpret(template, DATA, limit);
    } catch (err) {
      assert.ok(err instanceof ExpansionLimitError);
      interpretThrew = true;
    }
    assert.equal(renderThrew, limit < full.length, `renderer limit behavior, seed ${seed}`);
    assert.equal(interpretThrew, renderThrew, `interpreter limit agreement, seed ${seed}`);
  }
});
