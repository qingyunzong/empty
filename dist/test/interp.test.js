import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, ScriptError, lit, sym, if_, begin, let_, call, op, throw_, try_, fn, } from '../src/index.js';
const main = (node, defs = []) => run({ defs, main: node });
/* ------------------------------ basics --------------------------------- */
test('arithmetic, comparison and builtins', () => {
    const r = main(op('+', lit(1), op('*', lit(2), lit(3)), op('-', lit(10), lit(4))));
    assert.equal(r.value, 13);
});
test('if / begin / let with lexical shadowing', () => {
    assert.equal(main(if_(op('<', lit(1), lit(2)), lit('yes'), lit('no'))).value, 'yes');
    assert.equal(main(begin(lit(1), lit(2), lit(3))).value, 3);
    // inner let shadows, outer binding unaffected after inner scope
    const prog = let_('x', lit(1), begin(let_('x', lit(2), sym('x')), sym('x')));
    assert.equal(main(prog).value, 1);
    assert.equal(main(let_('x', lit(1), let_('x', lit(2), sym('x')))).value, 2);
});
test('unbound variable is a host error', () => {
    assert.throws(() => main(sym('nope')), /Unbound variable: nope/);
});
test('recursive function computes correctly (factorial)', () => {
    const fact = fn('fact', ['n'], if_(op('=', sym('n'), lit(0)), lit(1), op('*', sym('n'), call('fact', op('-', sym('n'), lit(1))))));
    assert.equal(main(call('fact', lit(10)), [fact]).value, 3628800);
});
/* -------------------- deep recursion: host stack safe ------------------- */
test('deep NON-tail recursion (100k frames) does not overflow host stack', () => {
    const sum = fn('sum', ['n'], if_(op('=', sym('n'), lit(0)), lit(0), op('+', lit(1), call('sum', op('-', sym('n'), lit(1))))));
    const N = 100_000;
    const r = main(call('sum', lit(N)), [sum]);
    assert.equal(r.value, N);
    // every level allocates a fresh frame (the +1 is still pending)
    assert.equal(r.metrics.allocated, N + 1);
    assert.equal(r.metrics.maxDepth, N + 1);
    assert.equal(r.metrics.reused, 1); // only the outermost call reused <main>
});
test('deep TAIL recursion reuses one frame (200k) and stays O(1) deep', () => {
    const loop = fn('loop', ['n', 'acc'], if_(op('=', sym('n'), lit(0)), sym('acc'), call('loop', op('-', sym('n'), lit(1)), op('+', sym('acc'), sym('n')))));
    const N = 200_000;
    const r = main(call('loop', lit(N), lit(0)), [loop]);
    assert.equal(r.value, (N * (N + 1)) / 2);
    assert.equal(r.metrics.allocated, 1); // only <main>, reused in place
    assert.equal(r.metrics.reused, N + 1); // loop(N) .. loop(0)
    assert.equal(r.metrics.maxDepth, 1);
});
test('mutual tail recursion (even/odd, 100k) keeps a single frame', () => {
    const even = fn('even', ['n'], if_(op('=', sym('n'), lit(0)), lit(true), call('odd', op('-', sym('n'), lit(1)))));
    const odd = fn('odd', ['n'], if_(op('=', sym('n'), lit(0)), lit(false), call('even', op('-', sym('n'), lit(1)))));
    const N = 100_000;
    const r = main(call('even', lit(N)), [even, odd]);
    assert.equal(r.value, true);
    assert.equal(r.metrics.maxDepth, 1);
    assert.equal(r.metrics.allocated, 1);
});
/* ------------- tail calls vs pending finally (frame metering) ----------- */
test('pending finally forbids frame reuse: fresh frame per level', () => {
    // g(n) = try (if n=0 then 0 else g(n-1)) finally log(n)
    const g = fn('g', ['n'], try_(if_(op('=', sym('n'), lit(0)), lit(0), call('g', op('-', sym('n'), lit(1)))), { finallyBody: op('log', sym('n')) }));
    const r = main(call('g', lit(3)), [g]);
    assert.equal(r.value, 0);
    // frames: <main> reused by g(3); g(2), g(1), g(0) each allocate
    assert.equal(r.metrics.allocated, 4);
    assert.equal(r.metrics.reused, 1);
    assert.equal(r.metrics.maxDepth, 4);
    // finally blocks run innermost-first as the frames unwind
    assert.deepEqual(r.output, [0, 1, 2, 3]);
});
test('deep recursion forced non-tail by finally (50k) is still host-safe', () => {
    const g = fn('g', ['n'], try_(if_(op('=', sym('n'), lit(0)), lit(0), call('g', op('-', sym('n'), lit(1)))), { finallyBody: lit(null) }));
    const N = 50_000;
    const r = main(call('g', lit(N)), [g]);
    assert.equal(r.value, 0);
    assert.equal(r.metrics.allocated, N + 1);
    assert.equal(r.metrics.maxDepth, N + 1);
    assert.equal(r.metrics.reused, 1);
});
/* ------------------------- exceptions and finally ----------------------- */
test('catch recovers and binds the thrown value', () => {
    const r = main(try_(throw_(lit(7)), {
        catchVar: 'e',
        catchBody: op('+', sym('e'), lit(1)),
    }));
    assert.equal(r.value, 8);
});
test('finally runs on normal completion and preserves the value', () => {
    const r = main(try_(lit(42), { finallyBody: op('log', lit('done')) }));
    assert.equal(r.value, 42);
    assert.deepEqual(r.output, ['done']);
});
test('catch handles, finally still runs, caught value wins', () => {
    const r = main(try_(throw_(lit('x')), {
        catchVar: 'e',
        catchBody: lit('caught'),
        finallyBody: op('log', lit('fin')),
    }));
    assert.equal(r.value, 'caught');
    assert.deepEqual(r.output, ['fin']);
});
test('finally that throws OVERRIDES the normal result', () => {
    assert.throws(() => main(try_(lit(42), { finallyBody: throw_(lit('boom')) })), (e) => e instanceof ScriptError && e.value === 'boom');
});
test('finally that throws OVERRIDES an in-flight exception', () => {
    assert.throws(() => main(try_(throw_(lit('original')), { finallyBody: throw_(lit('override')) })), (e) => e instanceof ScriptError && e.value === 'override');
});
test('exception escaping a catch body still triggers the outer finally', () => {
    const prog = try_(try_(throw_(lit(1)), { catchVar: 'e', catchBody: throw_(lit(2)) }), { finallyBody: op('log', lit('outer-finally')) });
    let caught = null;
    try {
        main(prog);
    }
    catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof ScriptError);
    assert.equal(caught.value, 2);
});
test('finally runs during cross-frame unwind, innermost first', () => {
    // g(n) = try (if n=0 then throw 'deep' else g(n-1)) finally log(n)
    const g = fn('g', ['n'], try_(if_(op('=', sym('n'), lit(0)), throw_(lit('deep')), call('g', op('-', sym('n'), lit(1)))), { finallyBody: op('log', sym('n')) }));
    const r = main(try_(call('g', lit(2)), { catchVar: 'e', catchBody: sym('e') }), [g]);
    assert.equal(r.value, 'deep');
    assert.deepEqual(r.output, [0, 1, 2]); // g(0)'s finally runs first
});
/* ------------ explicit frame references verify exception order ---------- */
test('uncaught exception carries exact frame unwind trace (innermost first)', () => {
    // c throws; b and a wrap the call in (+ 1 ...) so no tail-call reuse:
    // frames must be distinct and the trace must list them in unwind order.
    const c = fn('c', [], throw_(lit('boom')));
    const b = fn('b', [], op('+', lit(1), call('c')));
    const a = fn('a', [], op('+', lit(1), call('b')));
    // begin keeps <main> alive so `a` gets its own frame too
    let caught = null;
    try {
        main(begin(call('a'), lit(0)), [a, b, c]);
    }
    catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof ScriptError);
    assert.equal(caught.value, 'boom');
    assert.deepEqual(caught.trace, [
        { id: 4, name: 'c' },
        { id: 3, name: 'b' },
        { id: 2, name: 'a' },
        { id: 1, name: '<main>' },
    ]);
});
test('tail-recursive throw unwinds a SINGLE reused frame regardless of depth', () => {
    const f = fn('f', ['n'], if_(op('=', sym('n'), lit(0)), throw_(lit('bottom')), call('f', op('-', sym('n'), lit(1)))));
    let caught = null;
    let metrics = null;
    try {
        const r = main(call('f', lit(10_000)), [f]);
        metrics = r.metrics;
    }
    catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof ScriptError);
    assert.equal(caught.value, 'bottom');
    // one reused frame only: the trace has exactly one entry
    assert.deepEqual(caught.trace, [{ id: 1, name: 'f' }]);
});
test('pending finally forces distinct frames, visible in the unwind trace', () => {
    // g(n) = try (if n=0 then throw 'x' else g(n-1)) finally log(n)
    const g = fn('g', ['n'], try_(if_(op('=', sym('n'), lit(0)), throw_(lit('x')), call('g', op('-', sym('n'), lit(1)))), { finallyBody: op('log', sym('n')) }));
    let caught = null;
    try {
        main(call('g', lit(2)), [g]);
    }
    catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof ScriptError);
    // <main> reused by g(2) (id 1); g(1) id 2; g(0) id 3 — no tail reuse
    // under a pending finally, and the trace proves the unwind order.
    assert.deepEqual(caught.trace, [
        { id: 3, name: 'g' },
        { id: 2, name: 'g' },
        { id: 1, name: 'g' },
    ]);
});
/* ------------------------------ run options ----------------------------- */
test('fuel limit aborts runaway programs', () => {
    const loop = fn('loop', [], call('loop'));
    assert.throws(() => run({ defs: [loop], main: call('loop') }, { fuel: 1000 }), /Fuel exhausted/);
});
