import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse,
  render,
  renderPlain,
  renderWithProvenance,
  RenderLimitError,
  RenderTypeError,
  TemplateSyntaxError,
  type Data,
  type ForNode,
  type Node,
  type RenderResult,
} from '../src/index.js';

// ---------- helpers ----------

function assertTiling(result: RenderResult): void {
  let pos = 0;
  for (const span of result.spans) {
    assert.ok(span.outStart < span.outEnd, 'no zero-length spans');
    assert.equal(span.outStart, pos, 'spans are contiguous and ordered');
    pos = span.outEnd;
  }
  assert.equal(pos, result.text.length, 'spans cover the whole output');
}

/** Map from raw variable path -> set of stringified values it may take. */
function allowedValues(source: string, data: Data): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (key: string, value: string) => {
    let set = map.get(key);
    if (set === undefined) map.set(key, (set = new Set()));
    set.add(value);
  };
  const str = (v: unknown): string =>
    v === null || v === undefined ? '' : String(v as string | number | boolean);
  const walkData = (prefix: string, value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      add(prefix, str(value));
      return;
    }
    if (Array.isArray(value)) return; // list contents are reached via loop variables
    for (const [k, v] of Object.entries(value)) walkData(`${prefix}.${k}`, v);
  };
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) walkData(key, value);
  }
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'if') {
        visit(node.thenBody);
        visit(node.elseBody);
      } else if (node.type === 'for') {
        const list = data[node.listPath.join('.')];
        assert.ok(Array.isArray(list), `fixture: ${node.listPath} must be an array`);
        for (const item of list as unknown[]) {
          walkData(node.itemName, item);
        }
        visit(node.body);
      }
    }
  };
  visit(parse(source));
  return map;
}

/** Verify every output character against its claimed origin. */
function assertMapping(source: string, data: Data, result: RenderResult): void {
  assertTiling(result);
  const allowed = allowedValues(source, data);
  for (const span of result.spans) {
    const slice = result.text.slice(span.outStart, span.outEnd);
    if (span.kind === 'template') {
      assert.equal(slice, source.slice(span.srcStart, span.srcEnd));
    } else {
      const values = allowed.get(span.name);
      assert.ok(values, `known variable ${span.name}`);
      assert.ok(values.has(slice), `variable ${span.name} produced a known value`);
      assert.equal(span.valueEnd - span.valueStart, slice.length);
    }
  }
  for (let i = 0; i < result.text.length; i++) {
    const origin = result.originAt(i);
    if (origin.kind === 'template') {
      assert.equal(result.text[i], source[origin.srcIndex]);
    } else {
      const values = [...(allowed.get(origin.name) ?? [])];
      assert.ok(
        values.some((v) => origin.valueIndex < v.length && v[origin.valueIndex] === result.text[i]),
        `char ${i} of ${origin.name} at value offset ${origin.valueIndex}`,
      );
    }
  }
}

// ---------- variables ----------

test('variables: basic, dotted, missing, non-string', () => {
  assert.equal(render('Hi {{ user.name }}!', { user: { name: 'Ada' } }), 'Hi Ada!');
  assert.equal(render('[{{ missing }}]', {}), '[]');
  assert.equal(render('{{ n }}/{{ b }}', { n: 42, b: true }), '42/true');
});

test('substituted content is not re-interpreted', () => {
  const data = { x: '{{ y }}', y: 'WRONG', tag: '{% if z %}', z: true };
  assert.equal(render('{{ x }}', data), '{{ y }}');
  assert.equal(render('{{ tag }}end', data), '{% if z %}end');
  assert.equal(render('{{ x }}{{ x }}', data), '{{ y }}{{ y }}');
});

// ---------- conditionals & loops ----------

test('conditionals: if/else/negation/nesting', () => {
  const t = '{% if vip %}VIP{% else %}regular{% endif %}';
  assert.equal(render(t, { vip: true }), 'VIP');
  assert.equal(render(t, { vip: false }), 'regular');
  assert.equal(render('{% if !vip %}no{% endif %}', { vip: false }), 'no');
  const nested = '{% if a %}{% if b %}AB{% else %}A{% endif %}{% endif %}';
  assert.equal(render(nested, { a: 1, b: 0 }), 'A');
  assert.equal(render(nested, { a: 1, b: 1 }), 'AB');
});

test('loops: arrays, empty arrays, nested scopes', () => {
  const t = '{% for u in users %}{{ u.name }};{% endfor %}';
  assert.equal(render(t, { users: [{ name: 'a' }, { name: 'b' }] }), 'a;b;');
  assert.equal(render(t, { users: [] }), '');
  assert.equal(render(t, {}), '');
  const nested = '{% for o in orders %}[{% for i in o.items %}{{ i }} {% endfor %}]{% endfor %}';
  assert.equal(render(nested, { orders: [{ items: [1, 2] }, { items: [3] }] }), '[1 2 ][3 ]');
});

test('type errors: rendering objects, looping non-arrays', () => {
  assert.throws(() => render('{{ o }}', { o: {} }), RenderTypeError);
  assert.throws(() => render('{% for x in n %}{% endfor %}', { n: 5 }), RenderTypeError);
});

// ---------- provenance ----------

test('provenance: every character attributed to template or variable', () => {
  const source = 'Dear {{ u.name }}, you have {{ n }} new mails.{% if vip %} Thanks!{% endif %}';
  const data: Data = { u: { name: 'Grace' }, n: 3, vip: true };
  const result = renderWithProvenance(source, data);
  assert.equal(result.text, 'Dear Grace, you have 3 new mails. Thanks!');
  assertMapping(source, data, result);

  const nameOrigin = result.originAt(5);
  assert.deepEqual(nameOrigin, { kind: 'variable', name: 'u.name', iteration: null, valueIndex: 0 });
  assert.deepEqual(result.originAt(0), { kind: 'template', srcIndex: 0 });
});

test('provenance: loop iterations are distinguished', () => {
  const source = '{% for u in users %}{{ u.name }}{% endfor %}';
  const data: Data = { users: [{ name: 'ab' }, { name: 'cd' }] };
  const result = renderWithProvenance(source, data);
  assert.equal(result.text, 'abcd');
  assertMapping(source, data, result);
  assert.deepEqual(result.originAt(1), { kind: 'variable', name: 'u.name', iteration: 0, valueIndex: 1 });
  assert.deepEqual(result.originAt(2), { kind: 'variable', name: 'u.name', iteration: 1, valueIndex: 0 });
});

test('originAt: out-of-range index throws', () => {
  const result = renderWithProvenance('hi', {});
  assert.throws(() => result.originAt(2), RangeError);
  assert.throws(() => result.originAt(-1), RangeError);
});

// ---------- nesting errors with source ranges ----------

test('syntax errors carry the original source range', () => {
  const unclosedIf = 'Hello {% if vip %}dear';
  try {
    parse(unclosedIf);
    assert.unreachable();
  } catch (err) {
    if (!(err instanceof TemplateSyntaxError)) throw err;
    assert.equal(err.start, 6);
    assert.equal(err.end, 18);
    assert.equal(err.excerpt(), '{% if vip %}');
  }

  const stray = 'a{% endif %}';
  try {
    parse(stray);
    assert.unreachable();
  } catch (err) {
    if (!(err instanceof TemplateSyntaxError)) throw err;
    assert.equal(err.excerpt(), '{% endif %}');
    assert.equal(stray.slice(err.start, err.end), '{% endif %}');
  }

  const unclosedFor = 'x{% for i in items %}y';
  try {
    parse(unclosedFor);
    assert.unreachable();
  } catch (err) {
    if (!(err instanceof TemplateSyntaxError)) throw err;
    assert.equal(err.excerpt(), '{% for i in items %}');
  }

  const unclosedVar = 'a {{ name';
  try {
    parse(unclosedVar);
    assert.unreachable();
  } catch (err) {
    if (!(err instanceof TemplateSyntaxError)) throw err;
    assert.equal(err.start, 2);
    assert.equal(err.end, unclosedVar.length);
  }

  const nestedUnclosed = '{% if a %}x{% if b %}y{% endif %}';
  try {
    parse(nestedUnclosed);
    assert.unreachable();
  } catch (err) {
    if (!(err instanceof TemplateSyntaxError)) throw err;
    assert.equal(err.excerpt(), '{% if a %}');
  }
});

// ---------- atomic length limit ----------

test('maxOutputLength: whole render fails atomically when exceeded', () => {
  const source = 'Hello {{ name }}, welcome!';
  const data: Data = { name: 'Ada' };
  const full = render(source, data);
  assert.equal(render(source, data, { maxOutputLength: full.length }), full);
  assert.throws(
    () => renderWithProvenance(source, data, { maxOutputLength: full.length - 1 }),
    (err: unknown) => err instanceof RenderLimitError && err.limit === full.length - 1,
  );
  // Failure is all-or-nothing even when the overflow happens at the very end.
  assert.throws(() => render('ab{{ x }}', { x: 'cd' }, { maxOutputLength: 3 }), RenderLimitError);
  // No partial result object escapes: the call throws instead of returning.
  let produced: RenderResult | null = null;
  try {
    produced = renderWithProvenance('{{ x }}{{ x }}{{ x }}', { x: '12345' }, { maxOutputLength: 7 });
  } catch (err) {
    assert.ok(err instanceof RenderLimitError);
  }
  assert.equal(produced, null);
});

// ---------- cross-check against the reference interpreter ----------

test('reference interpreter agrees on fixed cases', () => {
  const cases: Array<[string, Data]> = [
    ['', {}],
    ['plain text only', {}],
    ['{{ a }}{{ b }}', { a: 'x', b: 1 }],
    ['{% if f %}T{% else %}F{% endif %}', { f: 0 }],
    ['{% if !f %}N{% endif %}', { f: '' }],
    ['{% for u in users %}<{{ u.name }}:{{ u.qty }}>{% endfor %}', {
      users: [{ name: 'a', qty: 1 }, { name: 'b', qty: 2 }],
    }],
    ['{% if a %}{% for x in xs %}{{ x }}{% endfor %}{% endif %}', { a: true, xs: [1, 2, 3] }],
    ['literal {{ braces }} here', {}],
  ];
  for (const [source, data] of cases) {
    const result = renderWithProvenance(source, data);
    assert.equal(result.text, renderPlain(source, data), `interpreter agrees on ${JSON.stringify(source)}`);
    assertMapping(source, data, result);
  }
});

// Seeded PRNG for reproducible fuzzing.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: provenance mapping cross-checked with reference interpreter', () => {
  const rand = mulberry32(0xc0ffee);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const scalars = ['s1', 's2', 'n1', 'flag'] as const;
  // Note: '{', '}' and '%' are excluded from generated literals because a
  // literal adjacent to a tag could accidentally form a delimiter; literal
  // braces in safe positions are covered by fixed tests instead.
  const literals = ['Hello', ' ', ', ', '!', '\\n', 'Dear', '---', '?'];

  const genExpr = (): string => (rand() < 0.3 ? '!' : '') + pick(scalars);
  const genBody = (depth: number, inLoop: string | null): string => {
    let out = '';
    const parts = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < parts; i++) {
      const r = rand();
      if (r < 0.35) {
        out += pick(literals);
      } else if (r < 0.6) {
        out += inLoop !== null && rand() < 0.6
          ? `{{ ${inLoop}.${pick(['name', 'qty'])} }}`
          : `{{ ${pick(scalars)} }}`;
      } else if (r < 0.8 && depth < 2) {
        out += `{% if ${genExpr()} %}${genBody(depth + 1, inLoop)}{% else %}${genBody(depth + 1, inLoop)}{% endif %}`;
      } else if (depth < 1) {
        const list = pick(['users', 'users', 'empty'] as const);
        out += `{% for u in ${list} %}${genBody(depth + 1, 'u')}{% endfor %}`;
      } else {
        out += pick(literals);
      }
    }
    return out;
  };

  for (let iter = 0; iter < 300; iter++) {
    const source = genBody(0, null);
    const data: Data = {
      s1: `S1#${iter}`,
      s2: `S2#${iter}`,
      n1: iter,
      flag: iter % 2 === 0,
      users: [
        { name: `U0#${iter}`, qty: iter % 7 },
        { name: `U1#${iter}`, qty: (iter + 1) % 7 },
      ],
      empty: [],
    };
    const result = renderWithProvenance(source, data);
    assert.equal(result.text, renderPlain(source, data), `iter ${iter}: ${JSON.stringify(source)}`);
    assertMapping(source, data, result);
  }
});
