"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDoc = buildDoc;
/** Build a document one character at a time; returns the ops and char ids. */
function buildDoc(site, text) {
    const ops = [];
    const ids = [];
    let after = null;
    for (const ch of text) {
        const op = site.insert(after, ch);
        ops.push(op);
        ids.push(op.id);
        after = op.id;
    }
    return { ops, ids };
}
