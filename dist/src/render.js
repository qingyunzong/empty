"use strict";
/**
 * Render expanded arguments into a POSIX display string while keeping
 * per-byte provenance, and reverse-edit arguments back into their
 * original source files.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditConflictError = void 0;
exports.renderCommand = renderCommand;
exports.quoteTokenForFile = quoteTokenForFile;
exports.applyEdits = applyEdits;
const quote_js_1 = require("./quote.js");
/** Render one argument; returns display text and its per-byte source map. */
function renderArg(arg) {
    const src = (offset) => ({ file: arg.span.file, offset });
    if ((0, quote_js_1.isSafeArg)(arg.value)) {
        return { text: arg.value, map: arg.charMap.map(src) };
    }
    let text = "'";
    const map = [null];
    for (let i = 0; i < arg.value.length; i++) {
        const ch = arg.value[i];
        if (ch === "'") {
            text += `'\\''`;
            map.push(null, null, src(arg.charMap[i]), null);
        }
        else {
            text += ch;
            map.push(src(arg.charMap[i]));
        }
    }
    text += "'";
    map.push(null);
    return { text, map };
}
/** Build the display string for an expansion, tracking every byte's origin. */
function renderCommand(expansion) {
    let display = '';
    const byteMap = [];
    expansion.args.forEach((arg, index) => {
        if (index > 0) {
            display += ' ';
            byteMap.push(null);
        }
        const { text, map } = renderArg(arg);
        display += text;
        byteMap.push(...map);
    });
    return { display, byteMap, args: expansion.args, files: expansion.files };
}
class EditConflictError extends Error {
    conflicts;
    constructor(conflicts) {
        super(`conflicting edits for shared source span(s): ${conflicts
            .map((c) => `${c.span.file}:${c.span.start}:${c.span.end}`)
            .join(', ')}`);
        this.conflicts = conflicts;
        this.name = 'EditConflictError';
    }
}
exports.EditConflictError = EditConflictError;
/**
 * Quote a value in response-file syntax. Identical quoting rules to the
 * display string, except tokens that would be re-read as directives or
 * includes (`@`, `%`, `#` at token start) are always quoted.
 */
function quoteTokenForFile(value) {
    (0, quote_js_1.assertNoNul)(value);
    if ((0, quote_js_1.isSafeArg)(value) && !/^[@%#]/.test(value))
        return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function spanKey(span) {
    return `${span.file}:${span.start}:${span.end}`;
}
/**
 * Compute updated file contents after replacing the given arguments with
 * new values. Editing is by argument index; the change is written back to
 * the original source span, so every other reference to the same source
 * (e.g. a file included twice) stays globally consistent automatically.
 *
 * Atomicity: if two requested edits target the same source span with
 * different values, an EditConflictError is thrown and nothing is applied.
 */
function applyEdits(rendered, edits) {
    const bySpan = new Map();
    const conflicts = new Map();
    for (const edit of edits) {
        const arg = rendered.args[edit.argIndex];
        if (!arg)
            throw new Error(`argument index out of range: ${edit.argIndex}`);
        const replacement = quoteTokenForFile(edit.newValue);
        const key = spanKey(arg.span);
        const existing = bySpan.get(key);
        if (existing) {
            if (existing.replacement !== replacement) {
                const conflict = conflicts.get(key) ?? { span: arg.span, replacements: [existing.replacement] };
                if (!conflict.replacements.includes(replacement))
                    conflict.replacements.push(replacement);
                conflicts.set(key, conflict);
            }
            continue;
        }
        bySpan.set(key, { span: arg.span, replacement });
    }
    if (conflicts.size > 0)
        throw new EditConflictError([...conflicts.values()]);
    const byFile = new Map();
    for (const entry of bySpan.values()) {
        const list = byFile.get(entry.span.file) ?? [];
        list.push(entry);
        byFile.set(entry.span.file, list);
    }
    const result = new Map();
    for (const [file, entries] of byFile) {
        const base = rendered.files.get(file);
        if (base === undefined)
            throw new Error(`source file not in expansion snapshot: ${file}`);
        const sorted = [...entries].sort((a, b) => b.span.start - a.span.start);
        for (let k = 1; k < sorted.length; k++) {
            if (sorted[k].span.end > sorted[k - 1].span.start) {
                throw new EditConflictError([{ span: sorted[k].span, replacements: ['<overlapping spans>'] }]);
            }
        }
        let content = base;
        for (const { span, replacement } of sorted) {
            content = content.slice(0, span.start) + replacement + content.slice(span.end);
        }
        result.set(file, content);
    }
    return result;
}
