"use strict";
/**
 * POSIX shell word quoting and an independent decoder.
 *
 * No shell is ever started: `buildCommand` only produces a display string,
 * and `parseCommand` is a self-contained tokenizer for the POSIX shell
 * word syntax (single quotes, double quotes, backslash escapes, line
 * continuations, blank separators).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertNoNul = assertNoNul;
exports.isSafeArg = isSafeArg;
exports.quoteArg = quoteArg;
exports.buildCommand = buildCommand;
exports.parseCommand = parseCommand;
const SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
function assertNoNul(value, what = 'argument') {
    if (value.includes('\0')) {
        throw new Error(`NUL byte is not allowed in ${what}`);
    }
}
/** True when `arg` needs no quoting in a POSIX shell word. */
function isSafeArg(arg) {
    return SAFE_RE.test(arg);
}
/** Quote one argument as a POSIX shell word. Throws on NUL bytes. */
function quoteArg(arg) {
    assertNoNul(arg);
    if (isSafeArg(arg))
        return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
/** Build a display string from structured arguments. Never starts a shell. */
function buildCommand(args) {
    return args.map(quoteArg).join(' ');
}
const BLANKS = new Set([' ', '\t', '\n']);
const DQUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);
/**
 * Independent decoder for the display string produced by `buildCommand`.
 * Performs no expansions (`$`, backticks are kept literal) and never
 * starts a shell. Throws on malformed input and NUL bytes.
 */
function parseCommand(cmd) {
    assertNoNul(cmd, 'command string');
    const args = [];
    let current = null;
    let i = 0;
    while (i < cmd.length) {
        const c = cmd[i];
        if (current === null) {
            if (BLANKS.has(c)) {
                i++;
                continue;
            }
            current = '';
        }
        if (BLANKS.has(c)) {
            args.push(current);
            current = null;
            i++;
            continue;
        }
        if (c === '\\') {
            if (i + 1 >= cmd.length)
                throw new Error('dangling backslash');
            const next = cmd[i + 1];
            if (next !== '\n')
                current += next; // backslash-newline is a continuation
            i += 2;
            continue;
        }
        if (c === "'") {
            const end = cmd.indexOf("'", i + 1);
            if (end < 0)
                throw new Error('unterminated single quote');
            current += cmd.slice(i + 1, end);
            i = end + 1;
            continue;
        }
        if (c === '"') {
            i++;
            for (;;) {
                if (i >= cmd.length)
                    throw new Error('unterminated double quote');
                const d = cmd[i];
                if (d === '"') {
                    i++;
                    break;
                }
                if (d === '\\' && i + 1 < cmd.length && DQUOTE_ESCAPABLE.has(cmd[i + 1])) {
                    if (cmd[i + 1] !== '\n')
                        current += cmd[i + 1];
                    i += 2;
                    continue;
                }
                current += d;
                i++;
            }
            continue;
        }
        current += c;
        i++;
    }
    if (current !== null)
        args.push(current);
    return args;
}
