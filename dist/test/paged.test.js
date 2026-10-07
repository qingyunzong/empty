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
(0, node_test_1.default)('moving a character across pages never changes its id or node identity', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abcdefgh');
    const paged = new paged_1.PagedTextModel(3);
    paged.applyAll(ops);
    // 'h' starts on the last page (page 2 with pageSize 3).
    const target = ids[7];
    const before = paged.model.get(target);
    strict_1.default.equal(paged.locate(target).page, 2);
    // Delete the first three characters, pulling 'h' forward across a page.
    paged.applyAll([site.delete(ids[0]), site.delete(ids[1]), site.delete(ids[2])]);
    strict_1.default.equal(paged.text(), 'defgh');
    // 'h' moved from page 2 to page 1, but id and node object are untouched.
    strict_1.default.equal(paged.locate(target).page, 1);
    strict_1.default.equal(paged.model.get(target), before);
    strict_1.default.equal(paged.model.get(target).id, target);
});
(0, node_test_1.default)('pages tile the document in order and respect page size', () => {
    const site = new model_1.Site('s1');
    const { ops } = (0, helpers_1.buildDoc)(site, 'abcdefghij');
    const paged = new paged_1.PagedTextModel(4);
    paged.applyAll(ops);
    strict_1.default.equal(paged.pageCount, 3);
    strict_1.default.equal(paged.pageText(0), 'abcd');
    strict_1.default.equal(paged.pageText(1), 'efgh');
    strict_1.default.equal(paged.pageText(2), 'ij');
    strict_1.default.equal(Array.from({ length: paged.pageCount }, (_, i) => paged.pageText(i)).join(''), paged.text());
});
(0, node_test_1.default)('deletes shrink pages without disturbing surviving ids', () => {
    const site = new model_1.Site('s1');
    const { ops, ids } = (0, helpers_1.buildDoc)(site, 'abcdef');
    const paged = new paged_1.PagedTextModel(2);
    paged.applyAll(ops);
    strict_1.default.equal(paged.pageCount, 3);
    paged.apply(site.delete(ids[0]));
    paged.apply(site.delete(ids[1]));
    strict_1.default.equal(paged.text(), 'cdef');
    strict_1.default.equal(paged.pageCount, 2);
    strict_1.default.equal(paged.locate(ids[2]).page, 0);
    strict_1.default.equal(paged.locate(ids[5]).page, 1);
});
