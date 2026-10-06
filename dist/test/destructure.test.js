"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../src/index");
/** Scope whose reads/writes append to a shared side-effect log. */
function tracedScope(initial, log) {
    return new index_1.Scope(initial, {
        onRead: (name) => log.push(`read:${name}`),
        onWrite: (name) => log.push(`write:${name}`),
    });
}
(0, node_test_1.test)('binds nested object/array patterns', () => {
    const scope = new index_1.Scope();
    (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ p: (0, index_1.arrPat)([(0, index_1.id)('x'), (0, index_1.objPat)({ q: (0, index_1.id)('y') })]), r: (0, index_1.id)('r') }), (0, index_1.lit)({ p: [1, { q: 2 }], r: 3 }));
    strict_1.default.deepEqual(scope.snapshot(), { x: 1, y: 2, r: 3 });
});
(0, node_test_1.test)('supports holes and rest in array/object patterns', () => {
    const scope = new index_1.Scope();
    (0, index_1.destructureAssign)(scope, (0, index_1.arrPat)([(0, index_1.id)('a'), null, (0, index_1.id)('b')], 'others'), (0, index_1.lit)([1, 2, 3, 4, 5]));
    (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ keep: (0, index_1.id)('k') }, 'rest'), (0, index_1.lit)({ keep: 1, drop: 2, also: 3 }));
    strict_1.default.deepEqual(scope.snapshot(), {
        a: 1,
        b: 3,
        others: [4, 5],
        k: 1,
        rest: { drop: 2, also: 3 },
    });
});
(0, node_test_1.test)('default applies only to missing (undefined), null is preserved', () => {
    const scope = new index_1.Scope();
    (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ a: (0, index_1.id)('a', (0, index_1.lit)(10)), b: (0, index_1.id)('b', (0, index_1.lit)(20)) }), (0, index_1.lit)({ b: null }));
    (0, index_1.destructureAssign)(scope, (0, index_1.arrPat)([(0, index_1.id)('m', (0, index_1.lit)(1)), (0, index_1.id)('n', (0, index_1.lit)(2))]), (0, index_1.lit)([null]));
    strict_1.default.deepEqual(scope.snapshot(), { a: 10, b: null, m: null, n: 2 });
});
(0, node_test_1.test)('default on nested pattern fills missing object; null is not defaulted', () => {
    const scope = new index_1.Scope();
    (0, index_1.destructureAssign)(scope, (0, index_1.arrPat)([(0, index_1.withDefault)((0, index_1.objPat)({ a: (0, index_1.id)('a') }), (0, index_1.lit)({ a: 5 }))]), (0, index_1.lit)([]));
    strict_1.default.equal(scope.get('a'), 5);
    // null matched against an object pattern throws even when a default exists
    strict_1.default.throws(() => (0, index_1.destructureAssign)(scope, (0, index_1.arrPat)([(0, index_1.withDefault)((0, index_1.objPat)({ z: (0, index_1.id)('z') }), (0, index_1.lit)({ z: 9 }))]), (0, index_1.lit)([null])), TypeError);
    strict_1.default.equal(scope.has('z'), false);
});
(0, node_test_1.test)('evaluation order: RHS once, defaults in pattern order, writes last', () => {
    const log = [];
    const scope = tracedScope({
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
    }, log);
    (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({
        a: (0, index_1.id)('a'),
        b: (0, index_1.id)('b', (0, index_1.call)((0, index_1.ref)('d1'))),
        c: (0, index_1.id)('c', (0, index_1.call)((0, index_1.ref)('d2'))),
    }), (0, index_1.call)((0, index_1.ref)('mkRhs')));
    strict_1.default.deepEqual(log, [
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
    strict_1.default.equal(scope.get('a'), 1);
    strict_1.default.equal(scope.get('b'), 'D1');
    strict_1.default.equal(scope.get('c'), 'D2');
});
(0, node_test_1.test)('defaults observe pre-assignment scope (writes deferred to the end)', () => {
    const log = [];
    const scope = tracedScope({ a: 100 }, log);
    (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ a: (0, index_1.id)('a'), b: (0, index_1.id)('b', (0, index_1.ref)('a')) }), (0, index_1.lit)({ a: 1 }));
    // `b = a` read the OLD value of `a`, because no binding is written
    // until every RHS/default has been evaluated.
    strict_1.default.deepEqual(scope.snapshot(), { a: 1, b: 100 });
    strict_1.default.deepEqual(log, ['read:a', 'write:a', 'write:b']);
});
(0, node_test_1.test)('RHS is evaluated exactly once', () => {
    let calls = 0;
    const scope = new index_1.Scope({
        mk: () => {
            calls += 1;
            return { p: [1, 2] };
        },
    });
    (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ p: (0, index_1.arrPat)([(0, index_1.id)('x'), (0, index_1.id)('y')]) }), (0, index_1.call)((0, index_1.ref)('mk')));
    strict_1.default.equal(calls, 1);
    strict_1.default.equal(scope.get('x'), 1);
    strict_1.default.equal(scope.get('y'), 2);
});
(0, node_test_1.test)('atomicity: failing default writes no bindings at all', () => {
    const log = [];
    const scope = tracedScope({
        boom: () => {
            throw new Error('default exploded');
        },
    }, log);
    strict_1.default.throws(() => (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ x: (0, index_1.id)('x'), y: (0, index_1.id)('y', (0, index_1.call)((0, index_1.ref)('boom'))) }), (0, index_1.lit)({ x: 1 })), /default exploded/);
    strict_1.default.equal(scope.has('x'), false);
    strict_1.default.equal(scope.has('y'), false);
    strict_1.default.deepEqual(log.filter((e) => e.startsWith('write:')), []);
});
(0, node_test_1.test)('atomicity: structural mismatch mid-pattern writes nothing', () => {
    const scope = new index_1.Scope();
    strict_1.default.throws(() => (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ p: (0, index_1.arrPat)([(0, index_1.id)('x'), (0, index_1.id)('y')]) }), (0, index_1.lit)({ p: null })), TypeError);
    strict_1.default.equal(scope.has('x'), false);
    strict_1.default.equal(scope.has('y'), false);
});
(0, node_test_1.test)('atomicity: failing RHS writes nothing', () => {
    const scope = new index_1.Scope({
        boom: () => {
            throw new Error('rhs exploded');
        },
    });
    strict_1.default.throws(() => (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ a: (0, index_1.id)('a') }), (0, index_1.call)((0, index_1.ref)('boom'))), /rhs exploded/);
    strict_1.default.equal(scope.has('a'), false);
});
(0, node_test_1.test)('unresolvable reference in a default aborts before any write', () => {
    const scope = new index_1.Scope();
    strict_1.default.throws(() => (0, index_1.destructureAssign)(scope, (0, index_1.objPat)({ a: (0, index_1.id)('a'), b: (0, index_1.id)('b', (0, index_1.ref)('missing')) }), (0, index_1.lit)({ a: 1 })), ReferenceError);
    strict_1.default.equal(scope.has('a'), false);
    strict_1.default.equal(scope.has('b'), false);
});
