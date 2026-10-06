import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IndentDocument,
  parse,
  structureOf,
  formatTree,
  type SyntaxNode,
} from "../src/parser.js";

function allNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const walk = (n: SyntaxNode): void => {
    for (const c of n.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function childContents(node: SyntaxNode): string[] {
  return node.children.map((c) => c.content);
}

test("builds a tree from space indentation", () => {
  const { root, errors } = parse(["root", "  a", "    b", "  c", "tail"].join("\n"));
  assert.deepStrictEqual(errors, []);
  const r = root.children[0]!;
  assert.equal(r.content, "root");
  assert.equal(r.indent, 0);
  assert.deepStrictEqual(childContents(r), ["a", "c"]);
  const a = r.children[0]!;
  assert.deepStrictEqual(childContents(a), ["b"]);
  assert.equal(a.children[0]!.indent, 4);
  assert.deepStrictEqual(childContents(root), ["root", "tail"]);
});

test("rejects tabs: error lines reported and excluded from the tree", () => {
  const doc = new IndentDocument(["a", "\tbad", "  b", "c"].join("\n"));
  assert.deepStrictEqual(doc.getErrors(), [1]);
  assert.equal(doc.getNodeAtLine(1), undefined);
  assert.deepStrictEqual(childContents(doc.root), ["a", "c"]);
  const a = doc.getNodeAtLine(0)!;
  assert.deepStrictEqual(childContents(a), ["b"]);
});

test("blank lines do not change the indentation stack", () => {
  const doc = new IndentDocument(["a", "  b", "", "   ", "  c", "d"].join("\n"));
  assert.deepStrictEqual(doc.getErrors(), []);
  const a = doc.getNodeAtLine(0)!;
  assert.deepStrictEqual(childContents(a), ["b", "c"]);
  assert.deepStrictEqual(childContents(doc.root), ["a", "d"]);
});

test("dedent pops multiple levels at once", () => {
  const doc = new IndentDocument(["a", "  b", "    c", "      d", "e"].join("\n"));
  const e = doc.getNodeAtLine(4)!;
  assert.equal(e.parent, doc.root);
  assert.deepStrictEqual(childContents(doc.root), ["a", "e"]);
});

test("incremental edit reparses only the affected interval", () => {
  const lines: string[] = [];
  for (let k = 0; k < 100; k++) lines.push(`item${k}`);
  const doc = new IndentDocument(lines.join("\n"));
  const before = new Map(allNodes(doc.root).map((n) => [n.line, n.id]));

  const res = doc.applyEdit(10, 1, ["renamed"]);
  assert.equal(doc.getNodeAtLine(10)!.content, "renamed");
  // Reparsing stopped right after the edited line (line 11 re-synchronized).
  assert.equal(res.reparsed.start, 10);
  assert.equal(res.reparsed.end, 11);
  // Every other node kept its id.
  for (let l = 0; l < 100; l++) {
    if (l === 10) continue;
    assert.equal(doc.getNodeAtLine(l)!.id, before.get(l));
  }
  assert.deepStrictEqual(
    res.changes.map((c) => c.type).sort(),
    ["added", "removed"],
  );
});

test("ids are preserved for unchanged lines inside an edited hunk", () => {
  const doc = new IndentDocument(["a", "  x", "  y", "  z"].join("\n"));
  const xId = doc.getNodeAtLine(1)!.id;
  const zId = doc.getNodeAtLine(3)!.id;
  // Replace lines 1..3 (the "x y z" hunk) with "x new y z": x, y, z survive.
  const res = doc.applyEdit(1, 3, ["  x", "  new", "  y", "  z"]);
  assert.equal(doc.getNodeAtLine(1)!.id, xId);
  assert.equal(doc.getNodeAtLine(4)!.id, zId);
  assert.equal(doc.getNodeAtLine(2)!.content, "new");
  assert.deepStrictEqual(
    res.changes.filter((c) => c.type === "removed"),
    [],
  );
  assert.equal(res.changes.filter((c) => c.type === "added").length, 1);
  // Structure matches a full rebuild.
  const full = parse(doc.getText());
  assert.deepStrictEqual(structureOf(doc.root), structureOf(full.root));
});

test("moving a node to a new parent is reported as changed, id kept", () => {
  const doc = new IndentDocument(["a", "  b", "    c", "  d"].join("\n"));
  const cId = doc.getNodeAtLine(2)!.id;
  const dId = doc.getNodeAtLine(3)!.id;
  // Outdent "b" one level: "c" and "d" end up under different parents.
  const res = doc.applyEdit(1, 1, [" b"]);
  assert.equal(doc.getNodeAtLine(2)!.id, cId);
  assert.equal(doc.getNodeAtLine(3)!.id, dId);
  const changed = new Set(res.changes.filter((c) => c.type === "changed").map((c) => c.id));
  assert.ok(changed.has(cId));
  assert.ok(changed.has(dId));
  const full = parse(doc.getText());
  assert.deepStrictEqual(structureOf(doc.root), structureOf(full.root));
});

test("error lines shift with edits and are recomputed in the edited range", () => {
  const doc = new IndentDocument(["a", "\tbad", "b"].join("\n"));
  assert.deepStrictEqual(doc.getErrors(), [1]);
  const res = doc.applyEdit(0, 0, ["x", "\tworse"]);
  assert.deepStrictEqual(res.errors, [1, 3]);
  assert.deepStrictEqual(doc.getErrors(), [1, 3]);
  // Fixing the tab lines clears the errors.
  const res2 = doc.applyEdit(0, 2, ["x", "fine"]);
  assert.deepStrictEqual(res2.errors, [3]);
  const full = parse(doc.getText());
  assert.deepStrictEqual(doc.getErrors(), full.errors);
  assert.deepStrictEqual(structureOf(doc.root), structureOf(full.root));
});

test("deleting a parent re-parents or removes its subtree like a full rebuild", () => {
  const doc = new IndentDocument(["a", "  b", "    c", "  d", "e"].join("\n"));
  doc.applyEdit(1, 1, []); // delete "  b"
  const full = parse(doc.getText());
  assert.deepStrictEqual(structureOf(doc.root), structureOf(full.root));
  assert.deepStrictEqual(doc.getErrors(), full.errors);
});

test("formatTree renders a readable dump", () => {
  const doc = new IndentDocument(["a", "  b"].join("\n"));
  const dump = formatTree(doc.root);
  assert.ok(dump.includes('"a"'));
  assert.ok(dump.includes('"b"'));
});

// ---------------------------------------------------------------------------
// Randomized verification: after every random edit, the incrementally
// maintained tree must be structurally identical to a full rebuild, and the
// reported change set must be consistent with the id mapping.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
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

function randomLines(rng: () => number, count: number): string[] {
  const lines: string[] = [];
  for (let k = 0; k < count; k++) {
    const r = rng();
    if (r < 0.1) {
      lines.push("");
    } else if (r < 0.16) {
      lines.push("   ");
    } else if (r < 0.24) {
      lines.push("\tbad" + k);
    } else {
      const indent = Math.floor(rng() * 5) * (rng() < 0.5 ? 1 : 2);
      lines.push(" ".repeat(indent) + WORDS[Math.floor(rng() * WORDS.length)]!);
    }
  }
  return lines;
}

test("randomized edits: incremental result equals full rebuild", () => {
  const SEEDS = 60;
  const EDITS_PER_SEED = 40;
  let totalEdits = 0;
  let totalReparsedLines = 0;
  let totalLines = 0;

  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(seed);
    const doc = new IndentDocument(randomLines(rng, 5 + Math.floor(rng() * 20)).join("\n"));

    for (let step = 0; step < EDITS_PER_SEED; step++) {
      const oldText = doc.getText();
      const oldInfo = new Map(
        allNodes(doc.root).map((n) => [
          n.id,
          { indent: n.indent, content: n.content, parentId: n.parent ? n.parent.id : null },
        ]),
      );

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
      assert.equal(doc.getText(), expectedText, `text mismatch (seed ${seed}, step ${step})`);

      // Structure and errors equal a full rebuild.
      const full = parse(expectedText);
      assert.deepStrictEqual(
        structureOf(doc.root),
        structureOf(full.root),
        `tree mismatch (seed ${seed}, step ${step})`,
      );
      assert.deepStrictEqual([...doc.getErrors()], full.errors, `errors mismatch (seed ${seed}, step ${step})`);

      // Ids are unique; parent/child links and line index are consistent.
      const nodes = allNodes(doc.root);
      const ids = nodes.map((n) => n.id);
      assert.equal(new Set(ids).size, ids.length, "duplicate ids");
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const n of nodes) {
        assert.equal(doc.getNodeAtLine(n.line), n);
        assert.ok(n.parent, "node without parent");
        assert.ok(n.parent!.children.includes(n), "parent does not link back");
        const ln = expectedLines[n.line]!;
        assert.equal(n.content, ln.slice(n.indent));
        assert.equal(ln.slice(0, n.indent), " ".repeat(n.indent));
      }

      // Change set is consistent with the id mapping.
      const newIds = new Set(ids);
      const addedIds = new Set<number>();
      const removedIds = new Set<number>();
      const changedIds = new Set<number>();
      for (const ch of res.changes) {
        if (ch.type === "added") {
          assert.ok(!oldInfo.has(ch.id), `added id ${ch.id} existed before`);
          assert.ok(newIds.has(ch.id), `added id ${ch.id} missing now`);
          addedIds.add(ch.id);
        } else if (ch.type === "removed") {
          assert.ok(oldInfo.has(ch.id), `removed id ${ch.id} did not exist`);
          assert.ok(!newIds.has(ch.id), `removed id ${ch.id} still present`);
          removedIds.add(ch.id);
        } else {
          assert.ok(oldInfo.has(ch.id) && newIds.has(ch.id), `changed id ${ch.id} must survive`);
          changedIds.add(ch.id);
        }
      }
      // Every old id is either removed or survives; every new id is either
      // added or was already there.
      for (const id of oldInfo.keys()) {
        if (removedIds.has(id)) continue;
        assert.ok(newIds.has(id), `id ${id} vanished without a removed change`);
      }
      for (const id of newIds) {
        if (oldInfo.has(id)) continue;
        assert.ok(addedIds.has(id), `id ${id} appeared without an added change`);
      }
      // Surviving, unreported ids kept indent/content/parent; reported
      // "changed" ids actually changed parent.
      for (const [id, info] of oldInfo) {
        const node = byId.get(id);
        if (!node) continue;
        assert.equal(node.indent, info.indent, "reused id changed indent");
        assert.equal(node.content, info.content, "reused id changed content");
        if (changedIds.has(id)) {
          assert.notEqual(node.parent!.id, info.parentId, "changed id kept its parent");
        } else {
          assert.equal(node.parent!.id, info.parentId, `id ${id} moved without a changed change`);
        }
      }
    }
  }

  console.log(
    `randomized check: ${SEEDS} seeds x ${EDITS_PER_SEED} edits = ${totalEdits} edits; ` +
      `avg reparsed ${(totalReparsedLines / totalEdits).toFixed(1)} lines/edit, ` +
      `avg doc size ${(totalLines / totalEdits).toFixed(1)} lines`,
  );
});
