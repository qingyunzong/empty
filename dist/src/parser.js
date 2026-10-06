"use strict";
/**
 * Indentation-based syntax tree for editors.
 *
 * Parsing rules:
 *  - Hierarchy is derived from leading-space indentation only.
 *  - Any line containing a Tab is rejected: it is reported as an error line
 *    and excluded from the tree (it does not touch the indentation stack).
 *  - Blank lines (empty or spaces only) are skipped and never change the
 *    indentation stack.
 *
 * Incremental updates:
 *  - `applyEdit` replaces a line range and reparses only the affected
 *    interval, stopping early once the parser stack provably re-synchronizes
 *    with the old tree. The result is structurally identical to a full
 *    rebuild.
 *  - Node ids are preserved whenever a node keeps its (indent, content):
 *    untouched nodes before the edited range keep their identity, unchanged
 *    lines inside the edited range recycle their old ids, and nodes after
 *    the edited range keep theirs (only their line numbers shift).
 *  - The returned change list reports added / removed / changed nodes.
 *    "changed" means the node kept its id but its parent changed (it moved);
 *    pure line-number shifts caused by an edit above are not reported.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IndentDocument = exports.ROOT_ID = void 0;
exports.parse = parse;
exports.structureOf = structureOf;
exports.formatTree = formatTree;
exports.ROOT_ID = 0;
function classify(line) {
    if (line.indexOf("\t") !== -1)
        return "tab";
    if (/^ *$/.test(line))
        return "blank";
    return "code";
}
function indentOf(line) {
    let n = 0;
    while (n < line.length && line.charCodeAt(n) === 32)
        n++;
    return n;
}
function makeNode(id, indent, content, line) {
    return { id, indent, content, line, parent: null, children: [] };
}
function makeRoot() {
    return { id: exports.ROOT_ID, indent: -1, content: "", line: -1, parent: null, children: [] };
}
function topOf(stack) {
    return stack[stack.length - 1];
}
/** Full parse of a text into a fresh tree (ids start at 1). */
function parse(text) {
    const root = makeRoot();
    const errors = [];
    let nextId = 1;
    const stack = [root];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const kind = classify(line);
        if (kind === "blank")
            continue;
        if (kind === "tab") {
            errors.push(i);
            continue;
        }
        const indent = indentOf(line);
        while (topOf(stack).indent >= indent)
            stack.pop();
        const parent = topOf(stack);
        const node = makeNode(nextId++, indent, line.slice(indent), i);
        node.parent = parent;
        parent.children.push(node);
        stack.push(node);
    }
    return { root, errors };
}
function structureOf(node) {
    return {
        indent: node.indent,
        content: node.content,
        children: node.children.map(structureOf),
    };
}
/** Human-readable dump of the tree (one line per node, with ids). */
function formatTree(root) {
    const out = [];
    const walk = (n, depth) => {
        out.push(`${"  ".repeat(depth)}#${n.id} [indent ${n.indent}] ${JSON.stringify(n.content)} (line ${n.line})`);
        for (const c of n.children)
            walk(c, depth + 1);
    };
    for (const c of root.children)
        walk(c, 0);
    return out.join("\n");
}
/**
 * A mutable document holding the current lines, the syntax tree, and the
 * list of tab-error lines. Supports incremental reparse after line edits.
 */
class IndentDocument {
    lines;
    root;
    errors = [];
    nodeByLine = new Map();
    nextId = 1;
    constructor(text) {
        this.lines = text.split("\n");
        this.root = makeRoot();
        this.parseAll();
    }
    parseAll() {
        const stack = [this.root];
        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            const kind = classify(line);
            if (kind === "blank")
                continue;
            if (kind === "tab") {
                this.errors.push(i);
                continue;
            }
            const indent = indentOf(line);
            while (topOf(stack).indent >= indent)
                stack.pop();
            const parent = topOf(stack);
            const node = makeNode(this.nextId++, indent, line.slice(indent), i);
            node.parent = parent;
            parent.children.push(node);
            this.nodeByLine.set(i, node);
            stack.push(node);
        }
    }
    get lineCount() {
        return this.lines.length;
    }
    getLines() {
        return this.lines;
    }
    getText() {
        return this.lines.join("\n");
    }
    /** 0-based line numbers that contain tabs. */
    getErrors() {
        return this.errors;
    }
    getNodeAtLine(line) {
        return this.nodeByLine.get(line);
    }
    /**
     * Replace `deleteCount` lines starting at `start` with `inserted`,
     * reparsing only the affected interval. Line numbers are 0-based and
     * clamped to the document.
     */
    applyEdit(start, deleteCount, inserted) {
        const oldLines = this.lines;
        const oldNodeByLine = this.nodeByLine;
        const oldErrors = this.errors;
        start = Math.max(0, Math.min(start, oldLines.length));
        deleteCount = Math.max(0, Math.min(deleteCount, oldLines.length - start));
        const end = start + deleteCount; // exclusive, old numbering
        const newEnd = start + inserted.length; // exclusive, new numbering
        const delta = inserted.length - deleteCount;
        const newLines = oldLines.slice(0, start).concat(inserted, oldLines.slice(end));
        // Snapshot old nodes for diffing (before any mutation).
        const oldInfo = new Map();
        for (const node of oldNodeByLine.values()) {
            oldInfo.set(node.id, {
                indent: node.indent,
                content: node.content,
                parentId: node.parent ? node.parent.id : null,
                line: node.line,
            });
        }
        // Rebuild the parser stack at `start` from the nearest preceding node:
        // the stack is exactly the ancestor chain of that node.
        let anchor = null;
        for (let l = start - 1; l >= 0; l--) {
            const n = oldNodeByLine.get(l);
            if (n) {
                anchor = n;
                break;
            }
        }
        const stack = [];
        if (anchor) {
            const chain = [];
            for (let n = anchor; n; n = n.parent)
                chain.push(n);
            for (let k = chain.length - 1; k >= 0; k--)
                stack.push(chain[k]);
        }
        else {
            stack.push(this.root);
        }
        // Context nodes keep only their untouched prefix children; remember the
        // original child lists for the early-termination splice.
        const origChildren = new Map();
        for (const n of stack) {
            origChildren.set(n.id, n.children);
            n.children = n.children.filter((c) => c.line < start);
        }
        // Pool of old nodes from the replaced range, keyed by (indent, content),
        // so unchanged lines inside the edited hunk recycle their ids.
        const pool = new Map();
        for (let l = start; l < end; l++) {
            const n = oldNodeByLine.get(l);
            if (n) {
                const key = n.indent + "\n" + n.content;
                const bucket = pool.get(key);
                if (bucket)
                    bucket.push(n);
                else
                    pool.set(key, [n]);
            }
        }
        const reusedOldIds = new Set();
        const addedNodes = [];
        const changedIds = new Set();
        const reparseErrors = [];
        const newNodeByLine = new Map();
        const newNodeById = new Map();
        for (const [line, node] of oldNodeByLine) {
            if (line < start) {
                newNodeByLine.set(line, node);
                newNodeById.set(node.id, node);
            }
        }
        let syncOldLine = oldLines.length;
        let terminatedAt = newLines.length;
        const noteReuse = (oldId, parent) => {
            reusedOldIds.add(oldId);
            const info = oldInfo.get(oldId);
            if (info.parentId !== parent.id)
                changedIds.add(oldId);
        };
        const attachTail = (node) => {
            // Adopt an untouched old subtree, shifting line numbers by delta.
            node.line += delta;
            newNodeByLine.set(node.line, node);
            newNodeById.set(node.id, node);
            reusedOldIds.add(node.id);
            for (const c of node.children)
                attachTail(c);
        };
        let i = start;
        parseLoop: for (; i < newLines.length; i++) {
            const line = newLines[i];
            const kind = classify(line);
            if (kind === "blank")
                continue;
            if (kind === "tab") {
                reparseErrors.push(i);
                continue;
            }
            const indent = indentOf(line);
            const content = line.slice(indent);
            while (topOf(stack).indent >= indent)
                stack.pop();
            const parent = topOf(stack);
            if (i >= newEnd) {
                // Past the edited range: the old document has a counterpart line.
                const oldNode = oldNodeByLine.get(i - delta);
                if (oldNode && oldNode.indent === indent && oldNode.content === content) {
                    // Early termination is only sound when the whole parser stack
                    // matches the old parse (same logical nodes, hence same indents);
                    // then everything from here on parses exactly as before.
                    const oldAnc = [];
                    for (let n = oldNode.parent; n; n = n.parent)
                        oldAnc.push(n);
                    oldAnc.reverse();
                    let matches = oldAnc.length === stack.length;
                    if (matches) {
                        for (let k = 0; k < stack.length; k++) {
                            if (oldAnc[k].id !== stack[k].id) {
                                matches = false;
                                break;
                            }
                        }
                    }
                    if (matches) {
                        const o = i - delta;
                        for (let k = 0; k < stack.length; k++) {
                            const s = stack[k];
                            const orig = origChildren.get(s.id) ?? oldAnc[k].children;
                            let idx = orig.length;
                            for (let j = 0; j < orig.length; j++) {
                                if (orig[j].line >= o) {
                                    idx = j;
                                    break;
                                }
                            }
                            for (const t of orig.slice(idx)) {
                                t.parent = s;
                                s.children.push(t);
                                attachTail(t);
                            }
                        }
                        terminatedAt = i;
                        syncOldLine = o;
                        break parseLoop;
                    }
                    // Same line, different context: keep the old id on a fresh node.
                    const node = makeNode(oldNode.id, indent, content, i);
                    node.parent = parent;
                    parent.children.push(node);
                    newNodeByLine.set(i, node);
                    newNodeById.set(node.id, node);
                    noteReuse(oldNode.id, parent);
                    stack.push(node);
                    continue;
                }
                // No reusable old node for this line.
                const node = makeNode(this.nextId++, indent, content, i);
                node.parent = parent;
                parent.children.push(node);
                newNodeByLine.set(i, node);
                newNodeById.set(node.id, node);
                addedNodes.push(node);
                stack.push(node);
                continue;
            }
            // Inside the replaced range: recycle an old id from the pool if the
            // (indent, content) matches an unchanged old line.
            const key = indent + "\n" + content;
            const bucket = pool.get(key);
            const recycled = bucket && bucket.length > 0 ? bucket.shift() : null;
            const node = makeNode(recycled ? recycled.id : this.nextId++, indent, content, i);
            node.parent = parent;
            parent.children.push(node);
            newNodeByLine.set(i, node);
            newNodeById.set(node.id, node);
            if (recycled)
                noteReuse(recycled.id, parent);
            else
                addedNodes.push(node);
            stack.push(node);
        }
        // Old nodes inside the reparsed interval that were not reused are gone.
        const removedIds = [];
        for (let l = start; l < syncOldLine; l++) {
            const n = oldNodeByLine.get(l);
            if (n && !reusedOldIds.has(n.id))
                removedIds.push(n.id);
        }
        // Errors: untouched prefix + reparsed interval + shifted tail.
        const errors = [];
        for (const l of oldErrors)
            if (l < start)
                errors.push(l);
        errors.push(...reparseErrors);
        for (const l of oldErrors)
            if (l >= syncOldLine)
                errors.push(l + delta);
        const changes = [];
        for (const node of addedNodes) {
            changes.push({ type: "added", id: node.id, indent: node.indent, content: node.content, line: node.line });
        }
        for (const id of removedIds) {
            const info = oldInfo.get(id);
            changes.push({ type: "removed", id, indent: info.indent, content: info.content, line: info.line });
        }
        for (const id of changedIds) {
            const node = newNodeById.get(id);
            changes.push({ type: "changed", id, indent: node.indent, content: node.content, line: node.line });
        }
        this.lines = newLines;
        this.errors = errors;
        this.nodeByLine = newNodeByLine;
        return { changes, errors: errors.slice(), reparsed: { start, end: terminatedAt } };
    }
}
exports.IndentDocument = IndentDocument;
