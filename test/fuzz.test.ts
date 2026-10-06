/**
 * Randomized edit verification: generate random configs (with comments and
 * blank lines), apply random set/delete operations through the library and
 * to a plain-data model in parallel, then after every op assert:
 *   1. the edited text re-parses and its tree equals the model;
 *   2. every full-line comment survives (verbatim, possibly relocated);
 *   3. unrelated scalar lexemes are byte-identical to the original;
 *   4. missing-path operations change nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parse,
  setByPath,
  deleteByPath,
  toPlain,
  formatScalar,
  resolve,
  type Document,
  type Node,
  type Path,
} from "../src/index.js";

// ---------- seeded RNG ----------
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

type Rng = () => number;
const pick = <T>(rng: Rng, xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
const int = (rng: Rng, n: number): number => Math.floor(rng() * n);

// ---------- random document generation ----------
type Val = null | boolean | number | string | Val[] | { [k: string]: Val };

const STRINGS = [
  "alpha", "beta", "hello world", "needs: colon", "with # hash", 'quote"inside',
  "it's", "123abc", "null", "true", "42", "", "a_b-c.d/e", "trailing ",
];

function randomScalar(rng: Rng): Val {
  switch (int(rng, 5)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return int(rng, 2000) - 1000;
    case 3: return Math.round((rng() * 200 - 100) * 100) / 100;
    default: return pick(rng, STRINGS);
  }
}

function randomValue(rng: Rng, depth: number): Val {
  if (depth >= 3) return randomScalar(rng);
  const kind = int(rng, depth === 0 ? 2 : 5); // root is always a container
  if (kind === 0) {
    const n = 1 + int(rng, 4);
    const obj: { [k: string]: Val } = {};
    for (let i = 0; i < n; i++) obj[`k${i}`] = randomValue(rng, depth + 1);
    return obj;
  }
  if (kind === 1) {
    const n = 1 + int(rng, 4);
    const arr: Val[] = [];
    for (let i = 0; i < n; i++) arr.push(randomValue(rng, depth + 1));
    return arr;
  }
  return randomScalar(rng);
}

function emitTrivia(rng: Rng, out: string[], indent: number): void {
  const pad = " ".repeat(indent);
  const n = int(rng, 3);
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.6) out.push(`${pad}# comment ${int(rng, 100)}`);
    else if (r < 0.8) out.push("");
    else out.push(`${pad}# another ${int(rng, 100)}`);
  }
}

function emitScalar(v: Val): string {
  return formatScalar(v);
}

function emitEntries(rng: Rng, obj: { [k: string]: Val }, indent: number, out: string[], firstPrefix?: string): void {
  const keys = Object.keys(obj);
  keys.forEach((key, i) => {
    const pad = " ".repeat(indent);
    if (i > 0 || firstPrefix === undefined) emitTrivia(rng, out, indent);
    const prefix = i === 0 && firstPrefix !== undefined ? firstPrefix : `${pad}`;
    const v = obj[key]!;
    const inline = rng() < 0.3 ? "  # inline note" : "";
    if (v !== null && typeof v === "object") {
      out.push(`${prefix}${key}:`);
      emitValue(rng, v, indent + 2, out);
    } else if (v === null && rng() < 0.5) {
      out.push(`${prefix}${key}:${inline}`);
    } else {
      out.push(`${prefix}${key}: ${emitScalar(v)}${inline}`);
    }
  });
}

function emitValue(rng: Rng, v: Val, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    for (const item of v) {
      emitTrivia(rng, out, indent);
      if (item !== null && typeof item === "object" && !Array.isArray(item) && rng() < 0.5) {
        emitEntries(rng, item, indent + 2, out, `${pad}- `); // inline seq-map
      } else if (item !== null && typeof item === "object") {
        out.push(`${pad}-`);
        emitValue(rng, item, indent + 2, out);
      } else if (item === null && rng() < 0.5) {
        out.push(`${pad}-`);
      } else {
        const inline = rng() < 0.3 ? "  # item note" : "";
        out.push(`${pad}- ${emitScalar(item)}${inline}`);
      }
    }
    emitTrivia(rng, out, indent);
  } else if (v !== null && typeof v === "object") {
    emitEntries(rng, v, indent, out);
    emitTrivia(rng, out, indent);
  } else {
    out.push(`${pad}${emitScalar(v)}`);
  }
}

// ---------- model operations (mirror the library semantics on plain data) ----------
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function modelSet(model: Val, path: Path, value: Val): boolean {
  let cur: Val = model;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (Array.isArray(cur)) {
      if (typeof seg !== "number" || seg < 0 || seg >= cur.length) return false;
      cur = cur[seg]!;
    } else if (cur !== null && typeof cur === "object") {
      if (!hasOwn(cur, String(seg))) return false;
      cur = (cur as Record<string, Val>)[String(seg)]!;
    } else return false;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cur)) {
    if (typeof last !== "number" || last < 0 || last >= cur.length) return false;
    cur[last] = value;
    return true;
  }
  if (cur !== null && typeof cur === "object" && hasOwn(cur, String(last))) {
    (cur as Record<string, Val>)[String(last)] = value;
    return true;
  }
  return false;
}

function modelDelete(model: Val, path: Path): { deleted: boolean; root: Val } {
  const stack: Array<[Val, string | number]> = [];
  let cur: Val = model;
  for (const seg of path) {
    if (Array.isArray(cur)) {
      if (typeof seg !== "number" || seg < 0 || seg >= cur.length) return { deleted: false, root: model };
      stack.push([cur, seg]);
      cur = cur[seg]!;
    } else if (cur !== null && typeof cur === "object") {
      if (!hasOwn(cur, String(seg))) return { deleted: false, root: model };
      stack.push([cur, seg]);
      cur = (cur as Record<string, Val>)[String(seg)]!;
    } else return { deleted: false, root: model };
  }
  const [parent, last] = stack.pop()!;
  if (Array.isArray(parent)) parent.splice(last as number, 1);
  else delete (parent as Record<string, Val>)[String(last)];
  const empty = Array.isArray(parent) ? parent.length === 0 : Object.keys(parent as object).length === 0;
  if (empty) {
    if (stack.length === 0) return { deleted: true, root: null };
    const [gp, gseg] = stack.pop()!;
    if (Array.isArray(gp)) gp[gseg as number] = null;
    else (gp as Record<string, Val>)[String(gseg)] = null;
  }
  return { deleted: true, root: model };
}

// ---------- tree walking / checks ----------
interface Cand {
  path: Path;
  scalar: boolean;
  deletable: boolean;
}

function collect(doc: Document): Cand[] {
  const out: Cand[] = [];
  const walk = (node: Node, path: Path): void => {
    if (node.kind === "scalar") {
      if (path.length) out.push({ path, scalar: true, deletable: false });
      return;
    }
    if (node.kind === "seq") {
      node.items.forEach((it, i) => {
        out.push({ path: [...path, i], scalar: false, deletable: true });
        walk(it.node, [...path, i]);
      });
      return;
    }
    node.entries.forEach((e, i) => {
      const inlineFirst =
        i === 0 &&
        e.lineStart === node.range[0] &&
        doc.src.slice(e.lineStart, e.keyRange[0]).includes("-");
      const deletable = !(inlineFirst && node.entries.length > 1);
      out.push({ path: [...path, e.key], scalar: false, deletable });
      walk(e.node, [...path, e.key]);
    });
  };
  walk(doc.root, []);
  return out;
}

function fullLineComments(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => l.trimStart().startsWith("#"))
    .sort();
}

function fullLineCommentsAt(src: string): Array<{ off: number; text: string }> {
  const out: Array<{ off: number; text: string }> = [];
  let pos = 0;
  for (const line of src.split("\n")) {
    if (line.trimStart().startsWith("#")) out.push({ off: pos, text: line });
    pos += line.length + 1;
  }
  return out;
}

function scalarLexemes(doc: Document): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (node: Node, path: Path): void => {
    if (node.kind === "scalar") {
      m.set(path.join("."), doc.src.slice(node.valueRange[0], node.valueRange[1]));
      return;
    }
    if (node.kind === "seq") node.items.forEach((it, i) => walk(it.node, [...path, i]));
    else node.entries.forEach((e) => walk(e.node, [...path, e.key]));
  };
  walk(doc.root, []);
  return m;
}

// ---------- the fuzz ----------
const DOCS = 40;
const OPS_PER_DOC = 60;

test("random edits: re-parse matches model, comments survive, unrelated bytes unchanged", () => {
  let setOps = 0;
  let deleteOps = 0;
  let missingOps = 0;
  let movedComments = 0;
  let regenDocs = 0;

  for (let d = 0; d < DOCS; d++) {
    const rng = mulberry32(0x9e3779b9 + d);
    const value = randomValue(rng, 0);
    const lines: string[] = [];
    emitValue(rng, value, 0, lines);
    let text = lines.join("\n") + "\n";

    // generator sanity: the emitted text parses back to the generated value
    assert.deepEqual(toPlain(parse(text).root), value, `doc ${d}: generator round-trip`);

    let model: Val = value;

    for (let op = 0; op < OPS_PER_DOC; op++) {
      if (collect(parse(text)).length === 0) {
        // document was deleted down to nothing: start a fresh one
        const v = randomValue(rng, 0);
        const ls: string[] = [];
        emitValue(rng, v, 0, ls);
        text = ls.join("\n") + "\n";
        model = v;
        regenDocs++;
      }
      const doc = parse(text);
      const cands = collect(doc);
      const beforeLexemes = scalarLexemes(doc);
      const beforeComments = fullLineComments(text);
      const oldText = text;
      let didSet = false;
      const roll = rng();
      let opDesc = "missing";

      if (roll < 0.1) {
        // missing path: must be a no-op
        const missing: Path = rng() < 0.5 ? [`nope${int(rng, 100)}`] : ["k0", `nope${int(rng, 100)}`, int(rng, 5)];
        const r1 = setByPath(doc, missing, randomScalar(rng));
        const r2 = deleteByPath(doc, missing);
        assert.equal(r1.changed, false, `doc ${d} op ${op}: set on missing path changed`);
        assert.equal(r2.changed, false, `doc ${d} op ${op}: delete on missing path changed`);
        assert.equal(r1.text, text);
        assert.equal(r2.text, text);
        missingOps++;
        continue;
      }

      const doSet = roll < 0.55;
      if (doSet) {
        const scalars = cands.filter((c) => c.scalar);
        if (scalars.length === 0) continue;
        const target = pick(rng, scalars);
        const newVal = randomScalar(rng);
        opDesc = `set ${JSON.stringify(target.path)} = ${JSON.stringify(newVal)}`;
        const r = setByPath(doc, target.path, newVal);
        assert.equal(r.changed, true, `doc ${d} op ${op}: set existing path not applied`);
        // only the target's lexical span may differ
        const e = r.edits[0]!;
        assert.equal(r.edits.length, 1);
        assert.equal(text.slice(0, e.start), r.text.slice(0, e.start), "prefix changed");
        assert.equal(text.slice(e.end), r.text.slice(r.text.length - (text.length - e.end)), "suffix changed");
        const ok = modelSet(model, target.path, newVal);
        assert.equal(ok, true);
        text = r.text;
        setOps++;
        didSet = true;
        // unrelated scalar lexemes unchanged
        const afterLexemes = scalarLexemes(parse(text));
        for (const [route, lex] of beforeLexemes) {
          if (route === target.path.join(".")) continue;
          assert.equal(afterLexemes.get(route), lex, `doc ${d} op ${op}: lexeme at ${route} changed`);
        }
      } else {
        const deletables = cands.filter((c) => c.deletable);
        if (deletables.length === 0) continue;
        const target = pick(rng, deletables);
        opDesc = `delete ${JSON.stringify(target.path)}`;
        const r = deleteByPath(doc, target.path);
        assert.equal(r.changed, true, `doc ${d} op ${op}: delete existing path not applied`);
        const res = modelDelete(model, target.path);
        assert.equal(res.deleted, true);
        model = res.root;
        if (r.edits.some((e) => e.insert.includes("#"))) movedComments++;
        text = r.text;
        deleteOps++;
        // unrelated scalar lexemes unchanged (skip routes under a seq parent:
        // sibling indices shift after a delete)
        const parentPath = target.path.slice(0, -1).join(".");
        const parentIsSeq = resolve(doc.root, target.path.slice(0, -1))?.node.kind === "seq";
        const afterLexemes = scalarLexemes(parse(text));
        for (const [route, lex] of beforeLexemes) {
          if (parentIsSeq && (parentPath === "" || route === parentPath || route.startsWith(parentPath + "."))) continue;
          const after = afterLexemes.get(route);
          if (after === undefined) continue; // route disappeared with the delete
          assert.equal(after, lex, `doc ${d} op ${op}: lexeme at ${route} changed`);
        }
        // comments survive unless they sat inside a removed span (comments
        // nested within a deleted subtree go away with it); comments moved
        // to the previous surviving item are re-inserted verbatim.
        const expectedComments = fullLineCommentsAt(oldText)
          .filter((c) => !r.edits.some((e) => e.end > e.start && c.off >= e.start && c.off < e.end))
          .map((c) => c.text);
        for (const e of r.edits) {
          if (!e.insert.includes("#")) continue;
          for (const line of e.insert.split("\n")) {
            if (line.trimStart().startsWith("#")) expectedComments.push(line);
          }
        }
        assert.deepEqual(fullLineComments(text), expectedComments.sort(), `doc ${d} op ${op}: comment lost`);
      }

      // 1. re-parse matches the model
      try {
        assert.deepEqual(toPlain(parse(text).root), model, `doc ${d} op ${op}: tree mismatch`);
      } catch (err) {
        console.log("OP:", opDesc);
        console.log("OLD TEXT:\n" + oldText);
        console.log("NEW TEXT:\n" + text);
        throw err;
      }
      // 2. set ops never touch comments at all
      if (didSet) {
        assert.deepEqual(fullLineComments(text), beforeComments, `doc ${d} op ${op}: comment lost`);
      }
    }
  }

  assert.ok(setOps > 500, `too few set ops: ${setOps}`);
  assert.ok(deleteOps > 400, `too few delete ops: ${deleteOps}`);
  assert.ok(missingOps > 100, `too few missing-path ops: ${missingOps}`);
  assert.ok(movedComments > 20, `too few comment moves: ${movedComments}`);
  console.log(
    `  fuzz stats: ${DOCS} docs, set=${setOps}, delete=${deleteOps}, missing=${missingOps}, commentMoves=${movedComments}, regens=${regenDocs}`,
  );
});
