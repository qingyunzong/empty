import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Scope,
  destructureAssign,
  id,
  arrPat,
  objPat,
  withDefault,
  lit,
  ref,
  call,
} from '../src/index';

/** Scope whose reads/writes append to a shared side-effect log. */
function tracedScope(initial: Record<string, unknown>, log: string[]): Scope {
  return new Scope(initial, {
    onRead: (name) => log.push(`read:${name}`),
    onWrite: (name) => log.push(`write:${name}`),
  });
}

test('binds nested object/array patterns', () => {
  const scope = new Scope();
  destructureAssign(
    scope,
    objPat({ p: arrPat([id('x'), objPat({ q: id('y') })]), r: id('r') }),
    lit({ p: [1, { q: 2 }], r: 3 }),
  );
  assert.deepEqual(scope.snapshot(), { x: 1, y: 2, r: 3 });
});

test('supports holes and rest in array/object patterns', () => {
  const scope = new Scope();
  destructureAssign(scope, arrPat([id('a'), null, id('b')], 'others'), lit([1, 2, 3, 4, 5]));
  destructureAssign(scope, objPat({ keep: id('k') }, 'rest'), lit({ keep: 1, drop: 2, also: 3 }));
  assert.deepEqual(scope.snapshot(), {
    a: 1,
    b: 3,
    others: [4, 5],
    k: 1,
    rest: { drop: 2, also: 3 },
  });
});

test('default applies only to missing (undefined), null is preserved', () => {
  const scope = new Scope();
  destructureAssign(
    scope,
    objPat({ a: id('a', lit(10)), b: id('b', lit(20)) }),
    lit({ b: null }),
  );
  destructureAssign(scope, arrPat([id('m', lit(1)), id('n', lit(2))]), lit([null]));
  assert.deepEqual(scope.snapshot(), { a: 10, b: null, m: null, n: 2 });
});

test('default on nested pattern fills missing object; null is not defaulted', () => {
  const scope = new Scope();
  destructureAssign(
    scope,
    arrPat([withDefault(objPat({ a: id('a') }), lit({ a: 5 }))]),
    lit([]),
  );
  assert.equal(scope.get('a'), 5);

  // null matched against an object pattern throws even when a default exists
  assert.throws(
    () =>
      destructureAssign(
        scope,
        arrPat([withDefault(objPat({ z: id('z') }), lit({ z: 9 }))]),
        lit([null]),
      ),
    TypeError,
  );
  assert.equal(scope.has('z'), false);
});

test('evaluation order: RHS once, defaults in pattern order, writes last', () => {
  const log: string[] = [];
  const scope = tracedScope(
    {
      mkRhs: () => {
        log.push('eval:rhs');
        return { a: 1 };
      },
      d1: () => {
        log.push('eval:d1');
        return 'D1';
      },
      d2: () => {
        log.push('eval:d2');
        return 'D2';
      },
    },
    log,
  );
  destructureAssign(
    scope,
    objPat({
      a: id('a'),
      b: id('b', call(ref('d1'))),
      c: id('c', call(ref('d2'))),
    }),
    call(ref('mkRhs')),
  );
  assert.deepEqual(log, [
    'read:mkRhs',
    'eval:rhs',
    'read:d1',
    'eval:d1',
    'read:d2',
    'eval:d2',
    'write:a',
    'write:b',
    'write:c',
  ]);
  assert.equal(scope.get('a'), 1);
  assert.equal(scope.get('b'), 'D1');
  assert.equal(scope.get('c'), 'D2');
});

test('defaults observe pre-assignment scope (writes deferred to the end)', () => {
  const log: string[] = [];
  const scope = tracedScope({ a: 100 }, log);
  destructureAssign(
    scope,
    objPat({ a: id('a'), b: id('b', ref('a')) }),
    lit({ a: 1 }),
  );
  // `b = a` read the OLD value of `a`, because no binding is written
  // until every RHS/default has been evaluated.
  assert.deepEqual(scope.snapshot(), { a: 1, b: 100 });
  assert.deepEqual(log, ['read:a', 'write:a', 'write:b']);
});

test('RHS is evaluated exactly once', () => {
  let calls = 0;
  const scope = new Scope({
    mk: () => {
      calls += 1;
      return { p: [1, 2] };
    },
  });
  destructureAssign(scope, objPat({ p: arrPat([id('x'), id('y')]) }), call(ref('mk')));
  assert.equal(calls, 1);
  assert.equal(scope.get('x'), 1);
  assert.equal(scope.get('y'), 2);
});

test('atomicity: failing default writes no bindings at all', () => {
  const log: string[] = [];
  const scope = tracedScope(
    {
      boom: () => {
        throw new Error('default exploded');
      },
    },
    log,
  );
  assert.throws(
    () =>
      destructureAssign(
        scope,
        objPat({ x: id('x'), y: id('y', call(ref('boom'))) }),
        lit({ x: 1 }),
      ),
    /default exploded/,
  );
  assert.equal(scope.has('x'), false);
  assert.equal(scope.has('y'), false);
  assert.deepEqual(log.filter((e) => e.startsWith('write:')), []);
});

test('atomicity: structural mismatch mid-pattern writes nothing', () => {
  const scope = new Scope();
  assert.throws(
    () => destructureAssign(scope, objPat({ p: arrPat([id('x'), id('y')]) }), lit({ p: null })),
    TypeError,
  );
  assert.equal(scope.has('x'), false);
  assert.equal(scope.has('y'), false);
});

test('atomicity: failing RHS writes nothing', () => {
  const scope = new Scope({
    boom: () => {
      throw new Error('rhs exploded');
    },
  });
  assert.throws(
    () => destructureAssign(scope, objPat({ a: id('a') }), call(ref('boom'))),
    /rhs exploded/,
  );
  assert.equal(scope.has('a'), false);
});

test('unresolvable reference in a default aborts before any write', () => {
  const scope = new Scope();
  assert.throws(
    () => destructureAssign(scope, objPat({ a: id('a'), b: id('b', ref('missing')) }), lit({ a: 1 })),
    ReferenceError,
  );
  assert.equal(scope.has('a'), false);
  assert.equal(scope.has('b'), false);
});
