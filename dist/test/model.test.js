"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const model_1 = require("../src/model");
const helpers_1 = require("./helpers");
(0, node_test_1.default)('deleted anchor gravitates to the nearest surviving character on its right', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abcde');
    const model = (0, model_1.replay)(ops);
    // Cursor anchored before 'c'.
    strict_1.default.equal(model.resolveCursor(ids[2]), 2);
    // Delete 'c': anchor lands before 'd' (gap index 2 in "abde").
    model.apply(site.delete(ids[2]));
    strict_1.default.equal(model.text(), 'abde');
    strict_1.default.equal(model.resolveCursor(ids[2]), 2);
    // Delete 'd' as well: anchor lands before 'e' (gap index 2 in "abe").
    model.apply(site.delete(ids[3]));
    strict_1.default.equal(model.text(), 'abe');
    strict_1.default.equal(model.resolveCursor(ids[2]), 2);
    strict_1.default.equal(model.liveIds()[2], ids[4]);
});
(0, node_test_1.default)('deleted anchor with no survivor to its right lands at end of document', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abcde');
    const model = (0, model_1.replay)(ops);
    model.apply(site.delete(ids[4])); // delete 'e'
    strict_1.default.equal(model.resolveCursor(ids[4]), 4);
    model.apply(site.delete(ids[3])); // delete 'd'
    strict_1.default.equal(model.resolveCursor(ids[3]), 3);
    strict_1.default.equal(model.resolveCursor(ids[4]), 3);
    // Delete everything: every anchor resolves to 0 (also the end).
    model.apply(site.delete(ids[0]));
    model.apply(site.delete(ids[1]));
    model.apply(site.delete(ids[2]));
    strict_1.default.equal(model.text(), '');
    strict_1.default.equal(model.resolveCursor(ids[2]), 0);
});
(0, node_test_1.default)('null cursor always resolves to the end of the document', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abc');
    const model = (0, model_1.replay)(ops);
    strict_1.default.equal(model.resolveCursor(null), 3);
    model.apply(site.insert(ids[2], 'd'));
    strict_1.default.equal(model.resolveCursor(null), 4);
});
(0, node_test_1.default)('concurrent inserts at the same position are ordered by op id', () => {
    const siteA = new model_1.Site('a');
    const siteB = new model_1.Site('b');
    const { ops: base, ids } = (0, helpers_1.buildDoc)(siteA, 'a');
    // Both sites insert at the same position (afterId = id of 'a').
    const fromB1 = siteB.insert(ids[0], '1');
    const fromB2 = siteB.insert(ids[0], '2');
    const fromA = siteA.insert(ids[0], 'x');
    // Children of 'a' sort by op id: a#2 ('x') < b#1 ('1') < b#2 ('2').
    const expected = 'ax12';
    // Application order must not matter.
    strict_1.default.equal((0, model_1.replay)([...base, fromB2, fromA, fromB1]).text(), expected);
    strict_1.default.equal((0, model_1.replay)([...base, fromA, fromB1, fromB2]).text(), expected);
    strict_1.default.equal((0, model_1.replay)([...base, fromB1, fromB2, fromA]).text(), expected);
});
(0, node_test_1.default)('insert after a character nests under it regardless of arrival order', () => {
    const siteA = new model_1.Site('a');
    const siteB = new model_1.Site('b');
    const { ops: base, ids } = (0, helpers_1.buildDoc)(siteA, 'a');
    // B inserts 'x' after 'a'; A then inserts 'y' after 'x'.
    const bx = siteB.insert(ids[0], 'x');
    const ay = siteA.insert(bx.id, 'y');
    strict_1.default.equal((0, model_1.replay)([...base, bx, ay]).text(), 'axy');
    // Replaying in a different arrival order yields the same text.
    strict_1.default.equal((0, model_1.replay)([bx, ay, ...base].reverse()).text(), 'axy');
});
(0, node_test_1.default)('operations are idempotent under replay', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abc');
    const del = site.delete(ids[1]);
    const model = (0, model_1.replay)([...ops, del, ...ops, del]);
    strict_1.default.equal(model.text(), 'ac');
});
(0, node_test_1.default)('selection resolves to a normalized range', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abcdef');
    const model = (0, model_1.replay)(ops);
    // Reversed selection (anchor after head) normalizes.
    const range = model.resolveSelection({ anchor: ids[4], head: ids[1] });
    strict_1.default.deepEqual(range, { start: 1, end: 4 });
});
