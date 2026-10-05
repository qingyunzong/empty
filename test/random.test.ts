import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnyNode,
  Document,
  Path,
  deleteItem,
  getNode,
  parse,
  serializeScalar,
  setScalar,
  toJS,
} from '../src/index';

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

class Rnd {
  private nextFn: () => number;
  constructor(seed: number) {
    this.nextFn = mulberry32(seed);
  }
  float(): number {
    return this.nextFn();
  }
  int(n: number): number {
    return Math.floor(this.nextFn() * n);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  bool(p: number): boolean {
    return this.nextFn() < p;
  }
}

const STRING_POOL = [
  'foo',
  'bar',
  'hello world',
  '123',
  'true',
  'null',
  'a#b',
  'x: y',
  "it's",
  'say "hi"',
  '',
  ' padded ',
  '_under',
  'a.b/c',
  'ümlaut',
];

function genScalar(rnd: Rnd): unknown {
  switch (rnd.int(5)) {
    case 0:
      return rnd.int(2000) - 1000;
    case 1:
      return Math.round(rnd.float() * 2000) / 100 - 10;
    case 2:
      return rnd.bool(0.5);
    case 3:
      return null;
    default:
      return rnd.pick(STRING_POOL);
  }
}

function genValue(rnd: Rnd, depth: number): unknown {
  if (depth <= 0 || rnd.bool(0.45)) return genScalar(rnd);
  if (rnd.bool(0.5)) {
    const obj: Record<string, unknown> = {};
    const n = 1 + rnd.int(4);
    for (let i = 0; i < n; i++) obj[`k${i}`] = genValue(rnd, depth - 1);
    return obj;
  }
  const arr: unknown[] = [];
  const n = 1 + rnd.int(4);
  for (let i = 0; i < n; i++) arr.push(genValue(rnd, depth - 1));
  return arr;
}

/** Emit YAML text for a value, sprinkling blank lines and comments. */
function emit(rnd: Rnd, value: unknown, indent: number, lines: string[]): void {
  const pad = ' '.repeat(indent);
  const maybeTrivia = () => {
    if (rnd.bool(0.12)) lines.push('');
    if (rnd.bool(0.2)) lines.push(`${pad}# note ${rnd.int(100)}`);
  };
  const tail = () => (rnd.bool(0.25) ? `  # tail ${rnd.int(100)}` : '');
  if (Array.isArray(value)) {
    for (const item of value) {
      maybeTrivia();
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}-${tail()}`);
        emit(rnd, item, indent + 2, lines);
      } else {
        lines.push(`${pad}- ${serializeScalar(item)}${tail()}`);
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      maybeTrivia();
      if (val !== null && typeof val === 'object') {
        lines.push(`${pad}${key}:${tail()}`);
        emit(rnd, val, indent + 2, lines);
      } else {
        lines.push(`${pad}${key}: ${serializeScalar(val)}${tail()}`);
      }
    }
    return;
  }
  lines.push(`${pad}${serializeScalar(value)}`);
}

function genDoc(rnd: Rnd): { text: string; model: unknown } {
  const model = genValue(rnd, 3);
  const lines: string[] = [];
  if (rnd.bool(0.5)) lines.push('# header');
  emit(rnd, model, 0, lines);
  if (rnd.bool(0.3)) lines.push('# footer');
  return { text: lines.join('\n') + '\n', model };
}

interface Paths {
  scalars: Path[];
  items: Path[];
  containers: Path[];
}

function collectPaths(node: AnyNode, base: Path, out: Paths): void {
  if (node.kind === 'scalar') {
    if (base.length > 0) out.scalars.push(base);
    return;
  }
  if (base.length > 0) out.containers.push(base);
  if (node.kind === 'map') {
    for (const entry of node.entries) {
      const p = [...base, entry.key];
      out.items.push(p);
      collectPaths(entry.value, p, out);
    }
  } else {
    node.items.forEach((item, i) => {
      const p = [...base, i];
      out.items.push(p);
      collectPaths(item.value, p, out);
    });
  }
}

/** Empty containers reparse as null; normalize both sides before comparing. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return v.map(normalize);
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function modelGet(model: unknown, path: Path): unknown {
  let cur = model;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

function modelSet(model: unknown, path: Path, value: unknown): void {
  const parent = modelGet(model, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]] = value;
}

function modelDelete(model: unknown, path: Path): void {
  const parent = modelGet(model, path.slice(0, -1));
  const last = path[path.length - 1];
  if (Array.isArray(parent)) parent.splice(last as number, 1);
  else delete (parent as Record<string, unknown>)[last as string];
}

/** Independently rebuild the expected text of a deletion from line offsets. */
function expectedDelete(
  text: string,
  doc: Document,
  startLine: number,
  endLine: number,
  prevEndLine: number,
  comment: string | null,
): string {
  let out = '';
  for (let i = 0; i < doc.lines.length; i++) {
    if (i >= startLine && i <= endLine) continue;
    const line = doc.lines[i];
    if (i === prevEndLine && comment !== null) {
      out += text.slice(line.start, line.end) + '  ' + comment + text.slice(line.end, line.next);
    } else {
      out += text.slice(line.start, line.next);
    }
  }
  return out;
}

test('randomized edits: values stay correct and unrelated bytes stay intact', () => {
  const rnd = new Rnd(Number(process.env.SEED ?? 20261006));
  const DOCS = 40;
  const OPS = 60;
  const counts = { set: 0, setMissing: 0, setContainer: 0, del: 0, delMissing: 0 };

  for (let d = 0; d < DOCS; d++) {
    let { text, model } = genDoc(rnd);
    assert.deepEqual(toJS(parse(text).root), model, 'generated doc must reparse to its model');

    for (let op = 0; op < OPS; op++) {
      const doc = parse(text);
      const paths: Paths = { scalars: [], items: [], containers: [] };
      collectPaths(doc.root, [], paths);
      const roll = rnd.int(100);

      if (roll < 35 && paths.scalars.length > 0) {
        // set existing scalar: only the token span may change
        counts.set++;
        const path = rnd.pick(paths.scalars);
        const node = getNode(doc, path);
        if (node === null || node.kind !== 'scalar') throw new Error('expected scalar node');
        const value = genScalar(rnd);
        const result = setScalar(text, path, value);
        const { start, end } = node.span;
        assert.equal(result.slice(0, start), text.slice(0, start), 'prefix must be untouched');
        const tailLen = text.length - end;
        assert.equal(result.slice(result.length - tailLen), text.slice(end), 'suffix must be untouched');
        modelSet(model, path, value);
        text = result;
      } else if (roll < 50) {
        // set missing path: no modification
        counts.setMissing++;
        const path: Path = [`missing${rnd.int(10000)}`, rnd.int(5) > 2 ? 'deep' : 3];
        if (getNode(doc, path) !== null) continue;
        assert.equal(setScalar(text, path, genScalar(rnd)), text);
      } else if (roll < 60 && paths.containers.length > 0) {
        // set on a container: must throw, text untouched
        counts.setContainer++;
        const path = rnd.pick(paths.containers);
        assert.throws(() => setScalar(text, path, genScalar(rnd)));
      } else if (roll < 85 && paths.items.length > 0) {
        // delete existing item: exact line removal + comment migration
        counts.del++;
        const path = rnd.pick(paths.items);
        const parent = getNode(doc, path.slice(0, -1));
        if (parent === null || parent.kind === 'scalar') throw new Error('expected container');
        const last = path[path.length - 1];
        let startLine = -1;
        let endLine = -1;
        let prevEndLine = -1;
        if (parent.kind === 'map') {
          const idx = parent.entries.findIndex((e) => e.key === last);
          assert.ok(idx !== -1);
          startLine = parent.entries[idx].startLine;
          endLine = parent.entries[idx].endLine;
          if (idx > 0) prevEndLine = parent.entries[idx - 1].endLine;
        } else {
          const idx = last as number;
          startLine = parent.items[idx].startLine;
          endLine = parent.items[idx].endLine;
          if (idx > 0) prevEndLine = parent.items[idx - 1].endLine;
        }
        const firstLine = doc.lines[startLine];
        const comment =
          firstLine.commentStart !== -1 ? text.slice(firstLine.commentStart, firstLine.end) : null;
        const expected = expectedDelete(
          text,
          doc,
          startLine,
          endLine,
          comment !== null ? prevEndLine : -1,
          comment,
        );
        const result = deleteItem(text, path);
        assert.equal(result, expected, 'delete must remove exactly the item lines and move the tail comment');
        modelDelete(model, path);
        text = result;
      } else {
        // delete missing path: no modification
        counts.delMissing++;
        const path: Path = [`gone${rnd.int(10000)}`, rnd.int(7)];
        if (getNode(doc, path) !== null) continue;
        assert.equal(deleteItem(text, path), text);
      }

      // after every applied edit the reparsed tree must match the model
      assert.deepEqual(
        normalize(toJS(parse(text).root)),
        normalize(model),
        `tree mismatch after op ${op} in doc ${d}`,
      );
    }
  }

  assert.ok(counts.set > 0 && counts.del > 0 && counts.setMissing > 0 && counts.delMissing > 0);
  console.log('random op counts:', counts);
});
