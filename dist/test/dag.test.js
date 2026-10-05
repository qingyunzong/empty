import { deepEqual, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { descendantsOf, topoSort } from '../src/index.js';
const noop = () => null;
const stage = (id, deps = []) => ({ id, deps, run: noop });
test('topoSort orders dependencies before dependents', () => {
    const stages = [stage('C', ['B']), stage('B', ['A']), stage('A'), stage('D', ['A'])];
    const order = topoSort(stages);
    ok(order.indexOf('A') < order.indexOf('B'));
    ok(order.indexOf('B') < order.indexOf('C'));
    ok(order.indexOf('A') < order.indexOf('D'));
    deepEqual([...order].sort(), ['A', 'B', 'C', 'D']);
});
test('topoSort rejects cycles', () => {
    throws(() => topoSort([stage('A', ['B']), stage('B', ['A'])]), /cycle detected/);
});
test('validateStages rejects duplicates and unknown deps', () => {
    throws(() => topoSort([stage('A'), stage('A')]), /duplicate stage id/);
    throws(() => topoSort([stage('A', ['ghost'])]), /unknown stage ghost/);
});
test('descendantsOf returns transitive dependents only', () => {
    const stages = [stage('A'), stage('B', ['A']), stage('C', ['B']), stage('D', ['A'])];
    deepEqual([...descendantsOf(stages, 'A')].sort(), ['B', 'C', 'D']);
    deepEqual([...descendantsOf(stages, 'B')], ['C']);
    deepEqual([...descendantsOf(stages, 'D')], []);
});
