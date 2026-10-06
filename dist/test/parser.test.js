"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const parser_js_1 = require("../src/parser.js");
function allNodes(root) {
    const out = [];
    const walk = (n) => {
        for (const c of n.children) {
            out.push(c);
            walk(c);
        }
    };
    walk(root);
    return out;
}
function childContents(node) {
    return node.children.map((c) => c.content);
}
(0, node_test_1.test)("builds a tree from space indentation", () => {
    const { root, errors } = (0, parser_js_1.parse)(["root", "  a", "    b", "  c", "tail"].join("\n"));
    strict_1.default.deepStrictEqual(errors, []);
    const r = root.children[0];
    strict_1.default.equal(r.content, "root");
    strict_1.default.equal(r.indent, 0);
    strict_1.default.deepStrictEqual(childContents(r), ["a", "c"]);
    const a = r.children[0];
    strict_1.default.deepStrictEqual(childContents(a), ["b"]);
    strict_1.default.equal(a.children[0].indent, 4);
    strict_1.default.deepStrictEqual(childContents(root), ["root", "tail"]);
});
(0, node_test_1.test)("rejects tabs: error lines reported and excluded from the tree", () => {
    const doc = new parser_js_1.IndentDocument(["a", "\tbad", "  b", "c"].join("\n"));
    strict_1.default.deepStrictEqual(doc.getErrors(), [1]);
    strict_1.default.equal(doc.getNodeAtLine(1), undefined);
    strict_1.default.deepStrictEqual(childContents(doc.root), ["a", "c"]);
    const a = doc.getNodeAtLine(0);
    strict_1.default.deepStrictEqual(childContents(a), ["b"]);
});
(0, node_test_1.test)("blank lines do not change the indentation stack", () => {
    const doc = new parser_js_1.IndentDocument(["a", "  b", "", "   ", "  c", "d"].join("\n"));
    strict_1.default.deepStrictEqual(doc.getErrors(), []);
    const a = doc.getNodeAtLine(0);
    strict_1.default.deepStrictEqual(childContents(a), ["b", "c"]);
    strict_1.default.deepStrictEqual(childContents(doc.root), ["a", "d"]);
});
(0, node_test_1.test)("dedent pops multiple levels at once", () => {
    const doc = new parser_js_1.IndentDocument(["a", "  b", "    c", "      d", "e"].join("\n"));
    const e = doc.getNodeAtLine(4);
    strict_1.default.equal(e.parent, doc.root);
    strict_1.default.deepStrictEqual(childContents(doc.root), ["a", "e"]);
});
(0, node_test_1.test)("incremental edit reparses only the affected interval", () => {
    const lines = [];
    for (let k = 0; k < 100; k++)
        lines.push(`item${k}`);
    const doc = new parser_js_1.IndentDocument(lines.join("\n"));
    const before = new Map(allNodes(doc.root).map((n) => [n.line, n.id]));
    const res = doc.applyEdit(10, 1, ["renamed"]);
    strict_1.default.equal(doc.getNodeAtLine(10).content, "renamed");
    // Reparsing stopped right after the edited line (line 11 re-synchronized).
    strict_1.default.equal(res.reparsed.start, 10);
    strict_1.default.equal(res.reparsed.end, 11);
    // Every other node kept its id.
    for (let l = 0; l < 100; l++) {
        if (l === 10)
            continue;
        strict_1.default.equal(doc.getNodeAtLine(l).id, before.get(l));
    }
    strict_1.default.deepStrictEqual(res.changes.map((c) => c.type).sort(), ["added", "removed"]);
});
(0, node_test_1.test)("ids are preserved for unchanged lines inside an edited hunk", () => {
    const doc = new parser_js_1.IndentDocument(["a", "  x", "  y", "  z"].join("\n"));
    const xId = doc.getNodeAtLine(1).id;
    const zId = doc.getNodeAtLine(3).id;
    // Replace lines 1..3 (the "x y z" hunk) with "x new y z": x, y, z survive.
    const res = doc.applyEdit(1, 3, ["  x", "  new", "  y", "  z"]);
    strict_1.default.equal(doc.getNodeAtLine(1).id, xId);
    strict_1.default.equal(doc.getNodeAtLine(4).id, zId);
    strict_1.default.equal(doc.getNodeAtLine(2).content, "new");
    strict_1.default.deepStrictEqual(res.changes.filter((c) => c.type === "removed"), []);
    strict_1.default.equal(res.changes.filter((c) => c.type === "added").length, 1);
    // Structure matches a full rebuild.
    const full = (0, parser_js_1.parse)(doc.getText());
    strict_1.default.deepStrictEqual((0, parser_js_1.structureOf)(doc.root), (0, parser_js_1.structureOf)(full.root));
});
(0, node_test_1.test)("moving a node to a new parent is reported as changed, id kept", () => {
    const doc = new parser_js_1.IndentDocument(["a", "  b", "    c", "  d"].join("\n"));
    const cId = doc.getNodeAtLine(2).id;
    const dId = doc.getNodeAtLine(3).id;
    // Outdent "b" one level: "c" and "d" end up under different parents.
    const res = doc.applyEdit(1, 1, [" b"]);
    strict_1.default.equal(doc.getNodeAtLine(2).id, cId);
    strict_1.default.equal(doc.getNodeAtLine(3).id, dId);
    const changed = new Set(res.changes.filter((c) => c.type === "changed").map((c) => c.id));
    strict_1.default.ok(changed.has(cId));
    strict_1.default.ok(changed.has(dId));
    const full = (0, parser_js_1.parse)(doc.getText());
    strict_1.default.deepStrictEqual((0, parser_js_1.structureOf)(doc.root), (0, parser_js_1.structureOf)(full.root));
});
(0, node_test_1.test)("error lines shift with edits and are recomputed in the edited range", () => {
    const doc = new parser_js_1.IndentDocument(["a", "\tbad", "b"].join("\n"));
    strict_1.default.deepStrictEqual(doc.getErrors(), [1]);
    const res = doc.applyEdit(0, 0, ["x", "\tworse"]);
    strict_1.default.deepStrictEqual(res.errors, [1, 3]);
    strict_1.default.deepStrictEqual(doc.getErrors(), [1, 3]);
    // Fixing the tab lines clears the errors.
    const res2 = doc.applyEdit(0, 2, ["x", "fine"]);
    strict_1.default.deepStrictEqual(res2.errors, [3]);
    const full = (0, parser_js_1.parse)(doc.getText());
    strict_1.default.deepStrictEqual(doc.getErrors(), full.errors);
    strict_1.default.deepStrictEqual((0, parser_js_1.structureOf)(doc.root), (0, parser_js_1.structureOf)(full.root));
});
(0, node_test_1.test)("deleting a parent re-parents or removes its subtree like a full rebuild", () => {
    const doc = new parser_js_1.IndentDocument(["a", "  b", "    c", "  d", "e"].join("\n"));
    doc.applyEdit(1, 1, []); // delete "  b"
    const full = (0, parser_js_1.parse)(doc.getText());
    strict_1.default.deepStrictEqual((0, parser_js_1.structureOf)(doc.root), (0, parser_js_1.structureOf)(full.root));
    strict_1.default.deepStrictEqual(doc.getErrors(), full.errors);
});
(0, node_test_1.test)("formatTree renders a readable dump", () => {
    const doc = new parser_js_1.IndentDocument(["a", "  b"].join("\n"));
    const dump = (0, parser_js_1.formatTree)(doc.root);
    strict_1.default.ok(dump.includes('"a"'));
    strict_1.default.ok(dump.includes('"b"'));
});
// ---------------------------------------------------------------------------
// Randomized verification: after every random edit, the incrementally
// maintained tree must be structurally identical to a full rebuild, and the
// reported change set must be consistent with the id mapping.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const WORDS = ["alpha", "beta", "gamma", "x", "y", "foo()", "bar", "baz", "node", "leaf"];
function randomLines(rng, count) {
    const lines = [];
    for (let k = 0; k < count; k++) {
        const r = rng();
        if (r < 0.1) {
            lines.push("");
        }
        else if (r < 0.16) {
            lines.push("   ");
        }
        else if (r < 0.24) {
            lines.push("\tbad" + k);
        }
        else {
            const indent = Math.floor(rng() * 5) * (rng() < 0.5 ? 1 : 2);
            lines.push(" ".repeat(indent) + WORDS[Math.floor(rng() * WORDS.length)]);
        }
    }
    return lines;
}
(0, node_test_1.test)("randomized edits: incremental result equals full rebuild", () => {
    const SEEDS = 60;
    const EDITS_PER_SEED = 40;
    let totalEdits = 0;
    let totalReparsedLines = 0;
    let totalLines = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = mulberry32(seed);
        const doc = new parser_js_1.IndentDocument(randomLines(rng, 5 + Math.floor(rng() * 20)).join("\n"));
        for (let step = 0; step < EDITS_PER_SEED; step++) {
            const oldText = doc.getText();
            const oldInfo = new Map(allNodes(doc.root).map((n) => [
                n.id,
                { indent: n.indent, content: n.content, parentId: n.parent ? n.parent.id : null },
            ]));
            const start = Math.floor(rng() * (doc.lineCount + 1));
            const deleteCount = Math.floor(rng() * 5);
            const inserted = randomLines(rng, Math.floor(rng() * 5));
            const res = doc.applyEdit(start, deleteCount, inserted);
            totalEdits++;
            totalReparsedLines += res.reparsed.end - res.reparsed.start;
            totalLines += doc.lineCount;
            // Document text is what we asked for.
            const expectedLines = oldText.split("\n");
            expectedLines.splice(start, deleteCount, ...inserted);
            const expectedText = expectedLines.join("\n");
            strict_1.default.equal(doc.getText(), expectedText, `text mismatch (seed ${seed}, step ${step})`);
            // Structure and errors equal a full rebuild.
            const full = (0, parser_js_1.parse)(expectedText);
            strict_1.default.deepStrictEqual((0, parser_js_1.structureOf)(doc.root), (0, parser_js_1.structureOf)(full.root), `tree mismatch (seed ${seed}, step ${step})`);
            strict_1.default.deepStrictEqual([...doc.getErrors()], full.errors, `errors mismatch (seed ${seed}, step ${step})`);
            // Ids are unique; parent/child links and line index are consistent.
            const nodes = allNodes(doc.root);
            const ids = nodes.map((n) => n.id);
            strict_1.default.equal(new Set(ids).size, ids.length, "duplicate ids");
            const byId = new Map(nodes.map((n) => [n.id, n]));
            for (const n of nodes) {
                strict_1.default.equal(doc.getNodeAtLine(n.line), n);
                strict_1.default.ok(n.parent, "node without parent");
                strict_1.default.ok(n.parent.children.includes(n), "parent does not link back");
                const ln = expectedLines[n.line];
                strict_1.default.equal(n.content, ln.slice(n.indent));
                strict_1.default.equal(ln.slice(0, n.indent), " ".repeat(n.indent));
            }
            // Change set is consistent with the id mapping.
            const newIds = new Set(ids);
            const addedIds = new Set();
            const removedIds = new Set();
            const changedIds = new Set();
            for (const ch of res.changes) {
                if (ch.type === "added") {
                    strict_1.default.ok(!oldInfo.has(ch.id), `added id ${ch.id} existed before`);
                    strict_1.default.ok(newIds.has(ch.id), `added id ${ch.id} missing now`);
                    addedIds.add(ch.id);
                }
                else if (ch.type === "removed") {
                    strict_1.default.ok(oldInfo.has(ch.id), `removed id ${ch.id} did not exist`);
                    strict_1.default.ok(!newIds.has(ch.id), `removed id ${ch.id} still present`);
                    removedIds.add(ch.id);
                }
                else {
                    strict_1.default.ok(oldInfo.has(ch.id) && newIds.has(ch.id), `changed id ${ch.id} must survive`);
                    changedIds.add(ch.id);
                }
            }
            // Every old id is either removed or survives; every new id is either
            // added or was already there.
            for (const id of oldInfo.keys()) {
                if (removedIds.has(id))
                    continue;
                strict_1.default.ok(newIds.has(id), `id ${id} vanished without a removed change`);
            }
            for (const id of newIds) {
                if (oldInfo.has(id))
                    continue;
                strict_1.default.ok(addedIds.has(id), `id ${id} appeared without an added change`);
            }
            // Surviving, unreported ids kept indent/content/parent; reported
            // "changed" ids actually changed parent.
            for (const [id, info] of oldInfo) {
                const node = byId.get(id);
                if (!node)
                    continue;
                strict_1.default.equal(node.indent, info.indent, "reused id changed indent");
                strict_1.default.equal(node.content, info.content, "reused id changed content");
                if (changedIds.has(id)) {
                    strict_1.default.notEqual(node.parent.id, info.parentId, "changed id kept its parent");
                }
                else {
                    strict_1.default.equal(node.parent.id, info.parentId, `id ${id} moved without a changed change`);
                }
            }
        }
    }
    console.log(`randomized check: ${SEEDS} seeds x ${EDITS_PER_SEED} edits = ${totalEdits} edits; ` +
        `avg reparsed ${(totalReparsedLines / totalEdits).toFixed(1)} lines/edit, ` +
        `avg doc size ${(totalLines / totalEdits).toFixed(1)} lines`);
});
