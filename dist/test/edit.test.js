"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../src/index.js");
(0, node_test_1.test)('per-byte provenance: every display byte maps to its source byte', () => {
    const files = new Map([
        ['/main.rsp', "alpha 'it''s\nhere' @inc.rsp\n"],
        ['/inc.rsp', '"quoted arg"\n'],
    ]);
    const rendered = (0, index_js_1.renderCommand)((0, index_js_1.expandResponseFile)(files, '/main.rsp'));
    strict_1.default.equal(rendered.byteMap.length, rendered.display.length);
    // Reconstruct each argument's value purely from source bytes via byteMap.
    const parsed = (0, index_js_1.parseCommand)(rendered.display);
    strict_1.default.equal(parsed.length, rendered.args.length);
    rendered.args.forEach((arg, argIdx) => {
        strict_1.default.equal(arg.value, parsed[argIdx]);
        for (let i = 0; i < arg.value.length; i++) {
            const src = rendered.files.get(arg.span.file);
            strict_1.default.equal(src[arg.charMap[i]], arg.value[i]);
        }
    });
    // Spot-check: separator spaces and added quotes have no source.
    const firstSpace = rendered.display.indexOf(' ');
    strict_1.default.equal(rendered.byteMap[firstSpace], null);
    // A literal byte in the display maps to the exact source offset.
    const aOffset = rendered.display.indexOf('alpha');
    const src0 = rendered.byteMap[aOffset];
    strict_1.default.equal(src0.file, '/main.rsp');
    strict_1.default.equal(files.get('/main.rsp')[src0.offset], 'a');
    // Newline inside the quoted token maps back into main.rsp.
    const nl = rendered.display.indexOf('\n');
    const nlSrc = rendered.byteMap[nl];
    strict_1.default.equal(files.get(nlSrc.file)[nlSrc.offset], '\n');
});
(0, node_test_1.test)('reverse edit: one argument rewritten in its source file', () => {
    const files = new Map([
        ['/main.rsp', "alpha 'two words' gamma\n"],
    ]);
    const rendered = (0, index_js_1.renderCommand)((0, index_js_1.expandResponseFile)(files, '/main.rsp'));
    const updated = (0, index_js_1.applyEdits)(rendered, [{ argIndex: 1, newValue: "it's done\nnow" }]);
    strict_1.default.equal(updated.size, 1);
    const newMain = updated.get('/main.rsp');
    strict_1.default.equal(newMain, `alpha 'it'\\''s done\nnow' gamma\n`);
    // Re-expanding the edited graph yields the new value, same arg count.
    const again = (0, index_js_1.expandResponseFile)(new Map([['/main.rsp', newMain]]), '/main.rsp');
    strict_1.default.deepEqual(again.args.map((a) => a.value), ['alpha', "it's done\nnow", 'gamma']);
});
(0, node_test_1.test)('reverse edit: values that look like directives/includes are quoted', () => {
    const files = new Map([['/main.rsp', 'plain\n']]);
    const rendered = (0, index_js_1.renderCommand)((0, index_js_1.expandResponseFile)(files, '/main.rsp'));
    for (const tricky of ['@other.rsp', '%if X', '#comment', '']) {
        const updated = (0, index_js_1.applyEdits)(rendered, [{ argIndex: 0, newValue: tricky }]);
        const again = (0, index_js_1.expandResponseFile)(new Map([['/main.rsp', updated.get('/main.rsp')]]), '/main.rsp');
        strict_1.default.deepEqual(again.args.map((a) => a.value), [tricky], JSON.stringify(tricky));
    }
});
(0, node_test_1.test)('shared source referenced twice: single edit updates all references', () => {
    const files = new Map([
        ['/main.rsp', '@common.rsp\nmid\n@common.rsp\n'],
        ['/common.rsp', 'shared\n'],
    ]);
    const rendered = (0, index_js_1.renderCommand)((0, index_js_1.expandResponseFile)(files, '/main.rsp'));
    strict_1.default.deepEqual(rendered.args.map((a) => a.value), ['shared', 'mid', 'shared']);
    // Edit only the FIRST occurrence; the source is shared, so both update.
    const updated = (0, index_js_1.applyEdits)(rendered, [{ argIndex: 0, newValue: 'changed' }]);
    const merged = new Map(files);
    for (const [k, v] of updated)
        merged.set(k, v);
    const again = (0, index_js_1.expandResponseFile)(merged, '/main.rsp');
    strict_1.default.deepEqual(again.args.map((a) => a.value), ['changed', 'mid', 'changed']);
});
(0, node_test_1.test)('conflicting edits to a shared source are fully rejected', () => {
    const files = new Map([
        ['/main.rsp', '@common.rsp\nmid\n@common.rsp\n'],
        ['/common.rsp', 'shared\n'],
    ]);
    const rendered = (0, index_js_1.renderCommand)((0, index_js_1.expandResponseFile)(files, '/main.rsp'));
    strict_1.default.throws(() => (0, index_js_1.applyEdits)(rendered, [
        { argIndex: 0, newValue: 'one' },
        { argIndex: 1, newValue: 'middle' }, // fine on its own
        { argIndex: 2, newValue: 'two' }, // conflicts with argIndex 0
    ]), index_js_1.EditConflictError);
    // Nothing was applied: the input snapshot is untouched.
    strict_1.default.equal(files.get('/common.rsp'), 'shared\n');
    strict_1.default.equal(files.get('/main.rsp'), '@common.rsp\nmid\n@common.rsp\n');
    // Same value on both occurrences of the shared span is accepted.
    const ok = (0, index_js_1.applyEdits)(rendered, [
        { argIndex: 0, newValue: 'same' },
        { argIndex: 2, newValue: 'same' },
    ]);
    strict_1.default.equal(ok.get('/common.rsp'), 'same\n');
});
(0, node_test_1.test)('batch edits across multiple files apply together', () => {
    const files = new Map([
        ['/main.rsp', 'a @inc.rsp z\n'],
        ['/inc.rsp', 'b\n'],
    ]);
    const rendered = (0, index_js_1.renderCommand)((0, index_js_1.expandResponseFile)(files, '/main.rsp'));
    const updated = (0, index_js_1.applyEdits)(rendered, [
        { argIndex: 0, newValue: 'A' },
        { argIndex: 1, newValue: 'B B' },
        { argIndex: 2, newValue: 'Z' },
    ]);
    strict_1.default.equal(updated.get('/main.rsp'), 'A @inc.rsp Z\n');
    strict_1.default.equal(updated.get('/inc.rsp'), "'B B'\n");
});
