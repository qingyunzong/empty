/**
 * Reverse editing: change an argument in the display string and propagate
 * the change back to the original response-file sources.
 *
 * Because expansion records per-byte provenance, every argument maps back to
 * a source span (file, start, end). An edit replaces that span with the
 * re-encoded argument. When the same source span is referenced from several
 * places (e.g. one file included twice), a single edit updates every
 * reference consistently. If one batch of edits would require the same
 * source span to become two different texts, that is a conflict and the
 * whole batch is rejected: no file is modified.
 */
import { decodeSpans, encodeArg, decode } from "./quote.js";
import { expand, sourceSpans } from "./expand.js";
function spanKey(file, start, end) {
    return file + ":" + start + ":" + end;
}
/**
 * Plan the source replacements for a batch of edits without applying them.
 * Throws if an edit index is out of range.
 */
export function planEdits(exp, edits) {
    const args = decodeSpans(exp.text);
    const bySpan = new Map();
    const conflicts = [];
    const addReplacement = (rep) => {
        const key = spanKey(rep.file, rep.start, rep.end);
        const existing = bySpan.get(key);
        if (existing !== undefined) {
            if (existing.text !== rep.text) {
                conflicts.push({
                    file: rep.file,
                    start: rep.start,
                    end: rep.end,
                    first: existing.text,
                    second: rep.text,
                });
            }
            return;
        }
        bySpan.set(key, rep);
    };
    for (const edit of edits) {
        const arg = args[edit.index];
        if (arg === undefined) {
            throw new Error("argument index out of range: " + edit.index);
        }
        const token = encodeArg(edit.value);
        const spans = sourceSpans(exp, arg.start, arg.end);
        if (spans.length === 0) {
            throw new Error("internal error: no provenance for argument " + edit.index);
        }
        spans.forEach((span, k) => {
            addReplacement({
                file: span.file,
                start: span.start,
                end: span.end,
                // An argument normally lives in a single source span. If it ever
                // spans several, the full replacement goes into the first span and
                // the remaining spans are emptied.
                text: k === 0 ? token : "",
            });
        });
    }
    // Detect partial overlaps between different spans in the same file.
    const replacements = [...bySpan.values()];
    const perFile = new Map();
    for (const rep of replacements) {
        const list = perFile.get(rep.file) ?? [];
        list.push(rep);
        perFile.set(rep.file, list);
    }
    for (const list of perFile.values()) {
        list.sort((a, b) => a.start - b.start);
        for (let k = 1; k < list.length; k++) {
            const prev = list[k - 1];
            const cur = list[k];
            if (cur.start < prev.end) {
                conflicts.push({
                    file: cur.file,
                    start: cur.start,
                    end: cur.end,
                    first: prev.text,
                    second: cur.text,
                });
            }
        }
    }
    return { replacements, conflicts };
}
/**
 * Apply a batch of argument edits to the virtual file system.
 *
 * On conflict the result is `{ ok: false }` and nothing is modified; the
 * batch is all-or-nothing. On success the changed files, the re-expanded
 * display string and the new argument vector are returned.
 */
export function applyEdits(mainFile, vfs, conds, edits) {
    const exp = expand(mainFile, vfs, conds);
    const { replacements, conflicts } = planEdits(exp, edits);
    if (conflicts.length > 0) {
        return { ok: false, conflicts };
    }
    const perFile = new Map();
    for (const rep of replacements) {
        const list = perFile.get(rep.file) ?? [];
        list.push(rep);
        perFile.set(rep.file, list);
    }
    const files = new Map(vfs);
    for (const [file, list] of perFile) {
        const content = files.get(file);
        if (content === undefined) {
            throw new Error("internal error: replacement targets unknown file " + file);
        }
        let next = content;
        for (const rep of [...list].sort((a, b) => b.start - a.start)) {
            next = next.slice(0, rep.start) + rep.text + next.slice(rep.end);
        }
        files.set(file, next);
    }
    const expanded = expand(mainFile, files, conds);
    return { ok: true, files, expanded, args: decode(expanded.text), replacements };
}
