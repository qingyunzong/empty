"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const paged_1 = require("../src/paged");
const model_1 = require("../src/model");
const helpers_1 = require("./helpers");
/**
 * Scenario: base document "hello world", two branches diverge.
 *  - Branch A deletes 'o'(4) and 'w'(6), and appends '!' after 'd'(10).
 *  - Branch B inserts 'X' and 'Y' after 'h'(0), and deletes 'd'(10).
 * A selection made on branch B anchors on characters that get deleted,
 * exercising anchor gravitation after the merge.
 */
function scenario() {
    const base = new model_1.Site('base');
    const { ops: baseOps, ids } = (0, helpers_1.buildDoc)(base, 'hello world');
    const siteA = new model_1.Site('A');
    const branchA = [
        siteA.delete(ids[4]), // 'o'
        siteA.delete(ids[6]), // 'w'
        siteA.insert(ids[10], '!'),
    ];
    const siteB = new model_1.Site('B');
    const branchB = [
        siteB.insert(ids[0], 'X'),
        siteB.insert(ids[0], 'Y'),
        siteB.delete(ids[10]), // 'd'
    ];
    // Selection from branch B: anchor before 'o' (deleted by A),
    // head before 'd' (deleted by B itself).
    const selection = { anchor: ids[4], head: ids[10] };
    return { baseOps, branchA, branchB, selection, ids };
}
(0, node_test_1.default)('merging two branches converges regardless of replay order', () => {
    const { baseOps, branchA, branchB } = scenario();
    const merged = (0, model_1.mergeOps)(baseOps, branchA, branchB);
    const expected = 'hXYell orl!';
    strict_1.default.equal((0, model_1.replay)(merged).text(), expected);
    strict_1.default.equal((0, model_1.replay)([...branchB, ...baseOps, ...branchA]).text(), expected);
    strict_1.default.equal((0, model_1.replay)([...merged].reverse()).text(), expected);
});
(0, node_test_1.default)('selection after merge matches between paged and unpaginated models', () => {
    const { baseOps, branchA, branchB, selection } = scenario();
    const merged = (0, model_1.mergeOps)(baseOps, branchA, branchB);
    const flat = (0, model_1.replay)(merged);
    const paged = new paged_1.PagedTextModel(3); // tiny pages force cross-page moves
    paged.applyAll(merged);
    strict_1.default.equal(flat.text(), 'hXYell orl!');
    strict_1.default.equal(paged.text(), flat.text());
    strict_1.default.ok(paged.pageCount > 1);
    // Anchor was on deleted 'o': gravitates right to the surviving space
    // (live index 6). Head was on deleted 'd': gravitates right to '!' (10).
    const expected = { start: 6, end: 10 };
    strict_1.default.deepEqual(flat.resolveSelection(selection), expected);
    strict_1.default.deepEqual(paged.resolveSelection(selection), expected);
    strict_1.default.equal(flat.text().slice(expected.start, expected.end), ' orl');
});
(0, node_test_1.default)('selection anchored at a deleted tail character resolves to end in both models', () => {
    const base = new model_1.Site('base');
    const { ops: baseOps, ids } = (0, helpers_1.buildDoc)(base, 'abcdef');
    const siteA = new model_1.Site('A');
    const siteB = new model_1.Site('B');
    // Branch A deletes the tail 'def'; branch B inserts 'g' after 'c'.
    const branchA = [siteA.delete(ids[3]), siteA.delete(ids[4]), siteA.delete(ids[5])];
    const branchB = [siteB.insert(ids[2], 'g')];
    const merged = (0, model_1.mergeOps)(baseOps, branchA, branchB);
    const selection = { anchor: ids[1], head: ids[5] }; // head on deleted 'f'
    const flat = (0, model_1.replay)(merged);
    const paged = new paged_1.PagedTextModel(2);
    paged.applyAll(merged);
    strict_1.default.equal(flat.text(), 'abcg');
    strict_1.default.equal(paged.text(), flat.text());
    const expected = { start: 1, end: 4 }; // head falls off the right edge -> end of doc
    strict_1.default.deepEqual(flat.resolveSelection(selection), expected);
    strict_1.default.deepEqual(paged.resolveSelection(selection), expected);
});
(0, node_test_1.default)('cross-branch merge applied incrementally converges with full replay', () => {
    const { baseOps, branchA, branchB } = scenario();
    // Replica 1: base + A, then receives B.
    const r1 = (0, model_1.replay)((0, model_1.mergeOps)(baseOps, branchA));
    r1.applyAll(branchB);
    // Replica 2: base + B, then receives A.
    const r2 = (0, model_1.replay)((0, model_1.mergeOps)(baseOps, branchB));
    r2.applyAll(branchA);
    // Replica 3: paged, interleaved arrival.
    const r3 = new paged_1.PagedTextModel(4);
    r3.applyAll((0, model_1.mergeOps)(baseOps, branchA, branchB));
    strict_1.default.equal(r1.text(), r2.text());
    strict_1.default.equal(r3.text(), r1.text());
});
