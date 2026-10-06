import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Form, NonMonotoneConditionError, UnknownFieldError, and, computeVisibility, evaluate, lit, not, or, v, vis, } from '../src/index.js';
const names = (fields) => fields.map((f) => f.name);
/** Independent spec: S is a fixed point iff visible ⟺ condition holds under S. */
function isFixedPoint(fields, values, set) {
    return fields.every((f) => set.has(f.name) === evaluate(f.condition, { values, visible: set }));
}
function allSubsets(items) {
    const out = [[]];
    for (const item of items) {
        const size = out.length;
        for (let i = 0; i < size; i++)
            out.push([...out[i], item]);
    }
    return out;
}
test('hidden field is treated as unfilled (reads as false)', () => {
    const fields = [
        { name: 'a', condition: lit(false) }, // always hidden
        { name: 'b', condition: v('a') },
    ];
    const form = new Form(fields, { a: true });
    assert.equal(form.isVisible('a'), false);
    assert.equal(form.isVisible('b'), false); // a is hidden => unfilled => false
    assert.deepEqual(form.effectiveValues(), { a: undefined, b: undefined });
});
test('chain reveals one field per round, rounds are reported', () => {
    const form = new Form([
        { name: 'a', condition: lit(true) },
        { name: 'b', condition: v('a') },
        { name: 'c', condition: v('b') },
    ]);
    assert.deepEqual(form.visible, new Set(['a']));
    const result = form.applyBatch({ a: true, b: true });
    assert.deepEqual(result.rounds.map((r) => r.revealed), [['a'], ['b'], ['c']]);
    assert.deepEqual(result.rounds.map((r) => r.round), [1, 2, 3]);
    assert.deepEqual(result.rounds[2].visibleAfter, ['a', 'b', 'c']);
    assert.deepEqual(result.becameVisible, ['b', 'c']);
    assert.deepEqual(result.becameHidden, []);
    assert.deepEqual(form.effectiveValues(), { a: true, b: true, c: undefined });
});
test('batch update is atomic and reports the visible-set diff', () => {
    const form = new Form([
        { name: 'x', condition: lit(true) },
        { name: 'y', condition: lit(true) },
        { name: 'm', condition: v('x') },
        { name: 'n', condition: v('y') },
    ], { x: false, y: true });
    assert.deepEqual([...form.visible].sort(), ['n', 'x', 'y']);
    // One atomic batch flips both values; no intermediate state is observable.
    const result = form.applyBatch({ x: true, y: false });
    assert.deepEqual(result.becameVisible, ['m']);
    assert.deepEqual(result.becameHidden, ['n']);
    assert.deepEqual([...result.visible].sort(), ['m', 'x', 'y']);
});
test('clearing a value in a batch re-hides dependents', () => {
    const form = new Form([
        { name: 'a', condition: lit(true) },
        { name: 'b', condition: v('a') },
    ], { a: true });
    assert.equal(form.isVisible('b'), true);
    const result = form.applyBatch({ a: undefined });
    assert.deepEqual(result.becameHidden, ['b']);
    assert.equal(form.isVisible('b'), false);
});
test('cyclic positive dependencies settle at the least fixed point (all hidden)', () => {
    // a visible iff b is true; b visible iff a is true. Both values are true,
    // so "both visible" is a fixed point too — but the least fixed point
    // reached from all-hidden keeps both hidden.
    const fields = [
        { name: 'a', condition: v('b') },
        { name: 'b', condition: v('a') },
    ];
    const result = computeVisibility(fields, { a: true, b: true });
    assert.deepEqual(result.rounds, []);
    assert.deepEqual(result.visible, new Set());
    // Confirm the other fixed point exists and ours is the least one.
    assert.equal(isFixedPoint(fields, { a: true, b: true }, new Set(['a', 'b'])), true);
});
test('visibility predicates can create reveal cascades', () => {
    const form = new Form([
        { name: 'a', condition: lit(true) },
        { name: 'b', condition: vis('a') },
        { name: 'c', condition: and(vis('b'), v('a')) },
    ]);
    const result = form.applyBatch({ a: true });
    assert.deepEqual(result.rounds.map((r) => r.revealed), [['a'], ['b'], ['c']]);
});
test('rejects non-monotone hidden references', () => {
    const bad = [
        ['negated visible', not(vis('a'))],
        ['negated var (hidden reads as unfilled)', not(v('a'))],
        ['nested in and/or', and(lit(true), or(v('b'), not(vis('a'))))],
    ];
    for (const [label, cond] of bad) {
        assert.throws(() => new Form([{ name: 'a', condition: lit(true) }, { name: 'b', condition: cond }]), NonMonotoneConditionError, label);
    }
    // Negation of visibility-free expressions is fine.
    assert.doesNotThrow(() => new Form([{ name: 'a', condition: lit(true) }, { name: 'b', condition: not(not(v('a'))) }]));
});
test('validation: duplicates, unknown references, unknown values', () => {
    assert.throws(() => new Form([{ name: 'a', condition: lit(true) }, { name: 'a', condition: lit(true) }]), /Duplicate field name/);
    assert.throws(() => new Form([{ name: 'a', condition: v('ghost') }]), UnknownFieldError);
    assert.throws(() => new Form([{ name: 'a', condition: lit(true) }], { ghost: true }), UnknownFieldError);
    const form = new Form([{ name: 'a', condition: lit(true) }]);
    assert.throws(() => form.applyBatch({ ghost: true }), UnknownFieldError);
});
test('exhaustive truth-table verification against the fixed-point spec', () => {
    // Four boolean fields with mixed dependencies, including a positive
    // cycle (c <-> d) and visibility predicates.
    const fields = [
        { name: 'a', condition: lit(true) },
        { name: 'b', condition: or(v('a'), and(vis('a'), lit(false))) },
        { name: 'c', condition: and(v('b'), or(v('d'), lit(true))) },
        { name: 'd', condition: and(vis('c'), v('a')) },
    ];
    const all = names(fields);
    // Enumerate the full finite truth table: 2^4 value assignments.
    for (let mask = 0; mask < 1 << all.length; mask++) {
        const values = {};
        all.forEach((name, i) => {
            values[name] = Boolean(mask & (1 << i));
        });
        const result = computeVisibility(fields, values);
        // 1. The result is a fixed point of the visibility operator.
        assert.equal(isFixedPoint(fields, values, result.visible), true, `fixed point for mask ${mask}`);
        // 2. It is the unique least fixed point: enumerate every subset of
        //    fields, collect all fixed points, and compare.
        const fixedPoints = allSubsets(all)
            .map((subset) => new Set(subset))
            .filter((set) => isFixedPoint(fields, values, set));
        for (const fp of fixedPoints) {
            for (const name of result.visible) {
                assert.ok(fp.has(name), `least among fixed points for mask ${mask}`);
            }
        }
        // 3. Per-round changes are consistent: replaying the rounds reproduces
        //    the result, each round is round-atomic, and the set only grows.
        const replay = new Set();
        for (const round of result.rounds) {
            const expected = all.filter((name) => !replay.has(name) &&
                evaluate(fields.find((f) => f.name === name).condition, { values, visible: replay }));
            assert.deepEqual([...round.revealed].sort(), expected.sort());
            for (const name of round.revealed)
                replay.add(name);
            assert.deepEqual(round.visibleAfter, [...replay].sort());
        }
        assert.deepEqual([...replay].sort(), [...result.visible].sort());
        // 4. Hidden fields are unfilled in the effective view.
        const form = new Form(fields, values);
        for (const name of all) {
            assert.equal(form.effectiveValue(name), result.visible.has(name) ? values[name] : undefined);
        }
    }
});
