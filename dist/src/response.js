"use strict";
/**
 * Response-file expansion over a virtual file graph.
 *
 * File format (parsed byte by byte, never via a shell):
 *   # comment                       - only at line start
 *   %if NAME / %if !NAME            - conditional branch on presence
 *   %if NAME=VALUE / %if NAME!=VALUE
 *   %else / %endif
 *   @path/to/file                   - include another response file
 *                                     (relative to the including file)
 *   anything else                   - whitespace-separated argument tokens
 *
 * Tokens use POSIX-style quoting: 'literal' (may span newlines),
 * "double \" escapes", back\slash escapes. A token only counts as an
 * include when its leading `@` is unquoted, so "@file" stays literal.
 *
 * Every expanded argument carries the exact source span (file + byte
 * offsets) of its raw token plus a per-character map back to source
 * offsets, so display strings keep per-byte provenance.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandResponseFile = expandResponseFile;
const node_path_1 = require("node:path");
const quote_js_1 = require("./quote.js");
function normalizePath(p) {
    return node_path_1.posix.normalize(p);
}
function resolveInclude(fromFile, ref) {
    if (ref.startsWith('/'))
        return normalizePath(ref);
    return normalizePath(node_path_1.posix.join(node_path_1.posix.dirname(fromFile), ref));
}
const BLANKS = new Set([' ', '\t', '\r']);
function evalCondition(expr, conditions) {
    expr = expr.trim();
    const neq = expr.indexOf('!=');
    if (neq >= 0) {
        const name = expr.slice(0, neq).trim();
        return conditions[name] !== expr.slice(neq + 2).trim();
    }
    const eq = expr.indexOf('=');
    if (eq >= 0) {
        const name = expr.slice(0, eq).trim();
        return conditions[name] === expr.slice(eq + 1).trim();
    }
    if (expr.startsWith('!'))
        return !(expr.slice(1).trim() in conditions);
    return expr in conditions;
}
class Parser {
    files;
    conditions;
    used;
    out;
    stack = [];
    constructor(files, conditions, used, out) {
        this.files = files;
        this.conditions = conditions;
        this.used = used;
        this.out = out;
    }
    get active() {
        return this.stack.length === 0 || this.stack[this.stack.length - 1].active;
    }
    expand(file, includeStack) {
        const path = normalizePath(file);
        if (includeStack.includes(path)) {
            throw new Error(`include cycle detected: ${[...includeStack, path].join(' -> ')}`);
        }
        const content = this.files.get(path);
        if (content === undefined)
            throw new Error(`response file not found: ${path}`);
        (0, quote_js_1.assertNoNul)(content, `response file ${path}`);
        this.used.set(path, content);
        const savedStack = this.stack;
        this.stack = [];
        try {
            this.parseFile(path, content, [...includeStack, path]);
        }
        finally {
            this.stack = savedStack;
        }
    }
    parseFile(file, text, includeStack) {
        let i = 0;
        let lineStart = true;
        while (i < text.length) {
            const c = text[i];
            if (lineStart) {
                if (c === '\n') {
                    i++;
                    continue;
                }
                if (BLANKS.has(c)) {
                    i++;
                    continue;
                }
                if (c === '#') {
                    while (i < text.length && text[i] !== '\n')
                        i++;
                    continue;
                }
                if (c === '%') {
                    const nl = text.indexOf('\n', i);
                    const end = nl < 0 ? text.length : nl;
                    this.directive(file, text.slice(i, end).trim());
                    i = end;
                    continue;
                }
                lineStart = false;
            }
            if (c === '\n') {
                lineStart = true;
                i++;
                continue;
            }
            if (BLANKS.has(c)) {
                i++;
                continue;
            }
            i = this.token(file, text, i, includeStack);
        }
    }
    directive(file, line) {
        const sp = line.search(/[\s]/);
        const head = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
        if (head === '%if') {
            const parentActive = this.active;
            const taken = parentActive && evalCondition(rest, this.conditions);
            this.stack.push({ parentActive, taken, active: taken });
        }
        else if (head === '%else') {
            const top = this.stack[this.stack.length - 1];
            if (!top)
                throw new Error(`%else without %if in ${file}`);
            top.active = top.parentActive && !top.taken;
            top.taken = top.taken || top.active;
        }
        else if (head === '%endif') {
            if (!this.stack.pop())
                throw new Error(`%endif without %if in ${file}`);
        }
        else if (this.active) {
            throw new Error(`unknown directive in ${file}: ${head}`);
        }
    }
    /** Parse one token starting at offset `start`; returns offset past it. */
    token(file, text, start, includeStack) {
        let value = '';
        const charMap = [];
        let i = start;
        let unquotedAt = true; // still at an unquoted leading position
        let includeRef = null;
        while (i < text.length) {
            const c = text[i];
            if (c === '\n' || BLANKS.has(c))
                break;
            if (c === '\\') {
                if (i + 1 >= text.length)
                    throw new Error(`dangling backslash in ${file}`);
                const next = text[i + 1];
                if (next !== '\n') {
                    value += next;
                    charMap.push(i + 1);
                }
                i += 2;
                unquotedAt = false;
                continue;
            }
            if (c === "'") {
                const end = text.indexOf("'", i + 1);
                if (end < 0)
                    throw new Error(`unterminated single quote in ${file}`);
                for (let k = i + 1; k < end; k++) {
                    value += text[k];
                    charMap.push(k);
                }
                i = end + 1;
                unquotedAt = false;
                continue;
            }
            if (c === '"') {
                i++;
                for (;;) {
                    if (i >= text.length)
                        throw new Error(`unterminated double quote in ${file}`);
                    const d = text[i];
                    if (d === '"') {
                        i++;
                        break;
                    }
                    if (d === '\\' && i + 1 < text.length && ['$', '`', '"', '\\', '\n'].includes(text[i + 1])) {
                        if (text[i + 1] !== '\n') {
                            value += text[i + 1];
                            charMap.push(i + 1);
                        }
                        i += 2;
                        continue;
                    }
                    value += d;
                    charMap.push(i);
                    i++;
                }
                unquotedAt = false;
                continue;
            }
            if (unquotedAt && value === '' && c === '@') {
                // Possible include: capture the raw unquoted remainder of the token.
                let j = i + 1;
                while (j < text.length && text[j] !== '\n' && !BLANKS.has(text[j]))
                    j++;
                includeRef = text.slice(i + 1, j);
                i = j;
                break;
            }
            value += c;
            charMap.push(i);
            i++;
        }
        if (includeRef !== null) {
            if (!this.active)
                return i;
            this.expand(resolveInclude(file, includeRef), includeStack);
            return i;
        }
        if (this.active) {
            (0, quote_js_1.assertNoNul)(value, `argument from ${file}`);
            this.out.push({ value, span: { file, start, end: i }, charMap });
        }
        return i;
    }
}
/**
 * Expand `entry` (a path in `files`) into structured arguments with
 * full per-byte provenance. `conditions` selects `%if` branches.
 */
function expandResponseFile(files, entry, conditions = {}) {
    const used = new Map();
    const out = [];
    new Parser(files, conditions, used, out).expand(entry, []);
    return { args: out, files: used };
}
