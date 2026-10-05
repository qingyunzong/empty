"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../src/index.js");
(0, node_test_1.test)('expansion across multiple files with conditional branches', () => {
    const files = new Map([
        ['/main.rsp', [
                '# entry point',
                'alpha',
                '@sub/extra.rsp',
                '%if MODE=fast',
                'fast-flag',
                '%else',
                'slow-flag',
                '%endif',
                '%if DEBUG',
                'debug-on',
                '%endif',
                'omega',
            ].join('\n')],
        ['/sub/extra.rsp', 'beta gamma\n%if MODE!=fast\nextra-slow\n%endif\n'],
    ]);
    const fast = (0, index_js_1.expandResponseFile)(files, '/main.rsp', { MODE: 'fast' });
    strict_1.default.deepEqual(fast.args.map((a) => a.value), ['alpha', 'beta', 'gamma', 'fast-flag', 'omega']);
    const slow = (0, index_js_1.expandResponseFile)(files, '/main.rsp', { MODE: 'slow', DEBUG: '1' });
    strict_1.default.deepEqual(slow.args.map((a) => a.value), ['alpha', 'beta', 'gamma', 'extra-slow', 'slow-flag', 'debug-on', 'omega']);
});
(0, node_test_1.test)('cross-file quoting: quotes inside included files, quoted @ stays literal', () => {
    const files = new Map([
        ['/a.rsp', '@dir/b.rsp\n"@not-an-include"\n'],
        ['/dir/b.rsp', `'it'\\''s here' "double \\"q\\" and $VAR" plain\\ space\n'multi\nline'\n`],
    ]);
    const { args } = (0, index_js_1.expandResponseFile)(files, '/a.rsp');
    strict_1.default.deepEqual(args.map((a) => a.value), [`it's here`, 'double "q" and $VAR', 'plain space', 'multi\nline', '@not-an-include']);
    // provenance: first arg lives in b.rsp, last one in a.rsp
    strict_1.default.equal(args[0].span.file, '/dir/b.rsp');
    strict_1.default.equal(args[4].span.file, '/a.rsp');
});
(0, node_test_1.test)('virtual file graph: diamond include duplicates args with identical spans', () => {
    const files = new Map([
        ['/main.rsp', '@left.rsp\n@right.rsp\n'],
        ['/left.rsp', '@common.rsp\nL\n'],
        ['/right.rsp', '@common.rsp\nR\n'],
        ['/common.rsp', 'shared-arg\n'],
    ]);
    const { args } = (0, index_js_1.expandResponseFile)(files, '/main.rsp');
    strict_1.default.deepEqual(args.map((a) => a.value), ['shared-arg', 'L', 'shared-arg', 'R']);
    strict_1.default.deepEqual(args[0].span, args[2].span);
    strict_1.default.equal(args[0].span.file, '/common.rsp');
});
(0, node_test_1.test)('virtual file graph: include cycles are rejected', () => {
    const files = new Map([
        ['/a.rsp', '@b.rsp\n'],
        ['/b.rsp', '@a.rsp\n'],
    ]);
    strict_1.default.throws(() => (0, index_js_1.expandResponseFile)(files, '/a.rsp'), /cycle/);
    const selfLoop = new Map([['/s.rsp', '@s.rsp\n']]);
    strict_1.default.throws(() => (0, index_js_1.expandResponseFile)(selfLoop, '/s.rsp'), /cycle/);
});
(0, node_test_1.test)('missing files and NUL bytes are rejected', () => {
    strict_1.default.throws(() => (0, index_js_1.expandResponseFile)(new Map(), '/nope.rsp'), /not found/);
    const nul = new Map([['/n.rsp', 'a\0b\n']]);
    strict_1.default.throws(() => (0, index_js_1.expandResponseFile)(nul, '/n.rsp'), /NUL/);
});
(0, node_test_1.test)('end-to-end: expand -> render -> parse round-trips values and count', () => {
    const files = new Map([
        ['/main.rsp', "plain 'has space' '' 'quo''te' @sub.rsp\n"],
        ['/sub.rsp', "'new\nline' tab\\there\n"],
    ]);
    const expansion = (0, index_js_1.expandResponseFile)(files, '/main.rsp');
    const rendered = (0, index_js_1.renderCommand)(expansion);
    const values = expansion.args.map((a) => a.value);
    strict_1.default.deepEqual((0, index_js_1.parseCommand)(rendered.display), values);
    strict_1.default.equal(rendered.display, (0, index_js_1.buildCommand)(values));
});
