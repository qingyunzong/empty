"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../src/index.js");
(0, node_test_1.test)('round-trip: empty string, single quotes, newlines', () => {
    const cases = [
        '',
        "'",
        "''",
        "'''",
        '\n',
        '\n\n',
        'a\nb\nc',
        "it's",
        "don't stop",
        ' \t ',
        'a b',
        '"double"',
        'back\\slash',
        '$HOME `whoami` !bang *glob? [br] {br} ~tilde #hash',
        "mix'of\nevery thing\\else$",
    ];
    for (const value of cases) {
        strict_1.default.deepEqual((0, index_js_1.parseCommand)((0, index_js_1.buildCommand)([value])), [value], JSON.stringify(value));
    }
});
(0, node_test_1.test)('round-trip: multiple arguments keep count and values', () => {
    const args = ['', 'a', "x'y", 'line1\nline2', '', 'plain'];
    strict_1.default.deepEqual((0, index_js_1.parseCommand)((0, index_js_1.buildCommand)(args)), args);
});
(0, node_test_1.test)('NUL bytes are forbidden', () => {
    strict_1.default.throws(() => (0, index_js_1.quoteArg)('a\0b'), /NUL/);
    strict_1.default.throws(() => (0, index_js_1.buildCommand)(['ok', 'bad\0']), /NUL/);
    strict_1.default.throws(() => (0, index_js_1.parseCommand)('a\0b'), /NUL/);
});
(0, node_test_1.test)('decoder is independent: no expansion, malformed input rejected', () => {
    strict_1.default.deepEqual((0, index_js_1.parseCommand)(`'$HOME' "\\$x" ` + '\\`echo\\`'), ['$HOME', '$x', '`echo`']);
    strict_1.default.throws(() => (0, index_js_1.parseCommand)("'unterminated"), /unterminated single/);
    strict_1.default.throws(() => (0, index_js_1.parseCommand)('"unterminated'), /unterminated double/);
    strict_1.default.throws(() => (0, index_js_1.parseCommand)('dangling\\'), /dangling backslash/);
    strict_1.default.deepEqual((0, index_js_1.parseCommand)('a\\\nb'), ['ab']); // line continuation
});
function* strings(alphabet, maxLen) {
    yield '';
    if (maxLen === 0)
        return;
    for (const rest of strings(alphabet, maxLen - 1)) {
        for (const c of alphabet)
            yield c + rest;
    }
}
(0, node_test_1.test)('exhaustive round-trip over short tricky character set (len <= 3)', () => {
    const alphabet = ['a', '0', "'", '"', '\\', ' ', '\t', '\n', '$', '`', '!', '*', '~', '#', '@', '%'];
    let count = 0;
    for (const s of strings(alphabet, 3)) {
        strict_1.default.deepEqual((0, index_js_1.parseCommand)((0, index_js_1.buildCommand)([s])), [s], JSON.stringify(s));
        count++;
    }
    strict_1.default.equal(count, 1 + 16 + 256 + 4096);
});
(0, node_test_1.test)('exhaustive: concatenation never changes argument count (all pairs, len <= 2)', () => {
    const alphabet = ['a', "'", '"', '\\', ' ', '\n', '$', '`'];
    const pool = [...strings(alphabet, 2)]; // 1 + 8 + 64 = 73 strings
    let count = 0;
    for (const a of pool) {
        for (const b of pool) {
            const parsed = (0, index_js_1.parseCommand)((0, index_js_1.buildCommand)([a, b]));
            strict_1.default.equal(parsed.length, 2, `count changed for ${JSON.stringify([a, b])}`);
            strict_1.default.deepEqual(parsed, [a, b]);
            count++;
        }
    }
    strict_1.default.equal(count, 73 * 73);
});
(0, node_test_1.test)('exhaustive: all triples over minimal tricky set keep count 3', () => {
    const pool = [...strings(['a', "'", ' ', '\n'], 2)]; // 21 strings
    let count = 0;
    for (const a of pool)
        for (const b of pool)
            for (const c of pool) {
                const parsed = (0, index_js_1.parseCommand)((0, index_js_1.buildCommand)([a, b, c]));
                strict_1.default.equal(parsed.length, 3);
                strict_1.default.deepEqual(parsed, [a, b, c]);
                count++;
            }
    strict_1.default.equal(count, 21 ** 3);
});
