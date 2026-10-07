import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Env } from '../src/env.ts';
import { lit, ref, effect } from '../src/expr.ts';
import { id, arr, obj, def } from '../src/pattern.ts';
import { destructure } from '../src/destructure.ts';

test('binds a flat object pattern', () => {
  const env = Env.from({ src: { a: 1, b: 2 } });
  destructure(obj({ a: id('a'), b: id('b') }), ref('src'), env);
  assert.equal(env.get('a'), 1);
  assert.equal(env.get('b'), 2);
  assert.deepEqual(env.trace, ['read:src', 'write:a', 'write:b']);
});

test('binds nested array/object patterns and holes', () => {
  const env = Env.from({ src: { p: [1, 2, { q: 3 }] } });
  destructure(
    obj({ p: arr([id('x'), null, obj({ q: id('y') })]) }),
    ref('src'),
    env,
  );
  assert.equal(env.get('x'), 1);
  assert.equal(env.get('y'), 3);
  assert.equal(env.has('p'), false);
});

test('array rest and object rest collect the remainder', () => {
  const env = Env.from({ list: [1, 2, 3], rec: { a: 1, b: 2, c: 3 } });
  destructure(arr([id('head')], id('tail')), ref('list'), env);
  destructure(obj({ a: id('a') }, id('others')), ref('rec'), env);
  assert.deepEqual(env.get('tail'), [2, 3]);
  assert.deepEqual(env.get('others'), { b: 2, c: 3 });
});

test('default applies only when the value is missing (undefined)', () => {
  const env = Env.from({ src: {} });
  destructure(obj({ a: def(id('a'), effect('da', 42)) }), ref('src'), env);
  assert.equal(env.get('a'), 42);
  assert.deepEqual(env.trace, ['read:src', 'eval:da', 'write:a']);
});

test('present-but-undefined still triggers the default', () => {
  const env = Env.from({ src: { a: undefined } });
  destructure(obj({ a: def(id('a'), lit(7)) }), ref('src'), env);
  assert.equal(env.get('a'), 7);
});

test('null is preserved and never triggers the default', () => {
  const env = Env.from({ src: { a: null, list: [null] } });
  destructure(
    obj({
      a: def(id('a'), effect('da', 99)),
      list: arr([def(id('b'), effect('db', 88))]),
    }),
    ref('src'),
    env,
  );
  assert.equal(env.get('a'), null);
  assert.equal(env.get('b'), null);
  assert.deepEqual(env.trace, ['read:src', 'write:a', 'write:b']);
});

test('source and all defaults evaluate before any binding is written', () => {
  const env = Env.from({ src: { a: 1 }, d1: 10, d2: 20 });
  destructure(
    obj({
      a: id('a'),
      b: def(id('b'), ref('d1')),
      c: def(id('c'), ref('d2')),
    }),
    ref('src'),
    env,
  );
  assert.deepEqual(env.trace, [
    'read:src',
    'read:d1',
    'read:d2',
    'write:a',
    'write:b',
    'write:c',
  ]);
});

test('nested defaults evaluate depth-first in pattern order, writes last', () => {
  const env = Env.from({ src: { p: [undefined, 5] } });
  destructure(
    obj({
      p: arr([def(id('x'), effect('dx', 1)), id('y')]),
      q: def(
        obj({ r: def(id('z'), effect('dz', 2)) }),
        effect('dq', {}),
      ),
    }),
    ref('src'),
    env,
  );
  assert.deepEqual(env.trace, [
    'read:src',
    'eval:dx',
    'eval:dq',
    'eval:dz',
    'write:x',
    'write:y',
    'write:z',
  ]);
  assert.equal(env.get('x'), 1);
  assert.equal(env.get('y'), 5);
  assert.equal(env.get('z'), 2);
});

test('property getters run during evaluation, before any write', () => {
  const env = new Env();
  const src = {
    get first(): unknown {
      env.log('get:first');
      return 1;
    },
    get second(): unknown {
      env.log('get:second');
      return undefined;
    },
  };
  destructure(
    obj({ first: id('a'), second: def(id('b'), effect('db', 2)) }),
    lit(src),
    env,
  );
  assert.deepEqual(env.trace, [
    'get:first',
    'get:second',
    'eval:db',
    'write:a',
    'write:b',
  ]);
});

test('a failing default writes no bindings at all', () => {
  const env = Env.from({ src: { a: 1 } });
  assert.throws(
    () =>
      destructure(
        obj({ a: id('a'), b: def(id('b'), ref('missing')) }),
        ref('src'),
        env,
      ),
    /missing is not defined/,
  );
  assert.deepEqual(env.trace, ['read:src', 'read:missing']);
  assert.equal(env.has('a'), false);
  assert.equal(env.has('b'), false);
});

test('a throwing getter writes no bindings at all', () => {
  const env = new Env();
  const src = {
    get ok(): unknown {
      return 1;
    },
    get trap(): unknown {
      throw new Error('boom');
    },
  };
  assert.throws(
    () => destructure(obj({ ok: id('a'), trap: id('b') }), lit(src), env),
    /boom/,
  );
  assert.deepEqual(env.trace, []);
  assert.equal(env.has('a'), false);
  assert.equal(env.has('b'), false);
});

test('a failing source expression writes no bindings', () => {
  const env = new Env();
  assert.throws(
    () => destructure(obj({ a: id('a') }), ref('gone'), env),
    /gone is not defined/,
  );
  assert.deepEqual(env.trace, ['read:gone']);
  assert.equal(env.has('a'), false);
});

test('destructuring null or undefined against a pattern throws and writes nothing', () => {
  const env = Env.from({ nul: null, und: undefined, num: 5 });
  assert.throws(
    () => destructure(obj({ a: id('a') }), ref('nul'), env),
    TypeError,
  );
  assert.throws(
    () => destructure(arr([id('a')]), ref('und'), env),
    TypeError,
  );
  assert.throws(
    () => destructure(arr([id('a')]), ref('num'), env),
    TypeError,
  );
  assert.deepEqual(env.trace, ['read:nul', 'read:und', 'read:num']);
  assert.equal(env.has('a'), false);
});

test('a default can fill an entire nested subpattern', () => {
  const env = Env.from({ src: {} });
  destructure(
    obj({ p: def(obj({ q: id('q') }), lit({ q: 7 })) }),
    ref('src'),
    env,
  );
  assert.equal(env.get('q'), 7);
});

test('the source expression is evaluated exactly once', () => {
  const env = new Env();
  destructure(id('x'), effect('src', 42), env);
  assert.deepEqual(env.trace, ['eval:src', 'write:x']);
  assert.equal(env.get('x'), 42);
});
