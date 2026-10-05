import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/document.js';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['a', 'b', 'c', 'missing'];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'link', 'text', 'note'];

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function randomWords(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 4);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(rnd, WORDS));
  return out.join(' ');
}

function randomRef(rnd: () => number): string {
  const id = pick(rnd, IDS);
  return rnd() < 0.3 ? `[${id}][]` : `[${randomWords(rnd)}][${id}]`;
}

function randomLine(rnd: () => number): string {
  const r = rnd();
  if (r < 0.15) return '#'.repeat(1 + Math.floor(rnd() * 6)) + ' ' + randomWords(rnd);
  if (r < 0.32) {
    const id = pick(rnd, IDS);
    const url = `https://example.com/${id}/${Math.floor(rnd() * 1000)}`;
    return rnd() < 0.5 ? `[${id}]: ${url} "${randomWords(rnd)}"` : `[${id}]: ${url}`;
  }
  if (r < 0.45) return '';
  let line = randomWords(rnd);
  if (rnd() < 0.55) line += ' ' + randomRef(rnd);
  if (rnd() < 0.2) line += ' ' + randomRef(rnd);
  return line;
}

function randomLines(rnd: () => number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(randomLine(rnd));
  return out;
}

interface Snapshot {
  text: string;
  nodes: unknown[];
  defs: unknown[];
  deps: unknown[];
}

function snapshot(doc: Document): Snapshot {
  const text = doc.getText();
  const nodes = doc.getNodes();
  const indexById = new Map<number, number>();
  nodes.forEach((n, i) => indexById.set(n.id, i));
  return {
    text,
    nodes: nodes.map((n) => {
      // Source ranges must slice back the exact node text.
      assert.equal(text.slice(n.start, n.end), n.text, 'source range mismatch');
      return {
        kind: n.kind,
        level: n.level ?? null,
        start: n.start,
        end: n.end,
        startLine: n.startLine,
        endLine: n.endLine,
        text: n.text,
        refs: n.refs,
        links: n.links.map((l) => ({ text: l.text, id: l.id, url: l.url ?? null, title: l.title ?? null })),
      };
    }),
    defs: [...doc.getDefinitions().entries()]
      .map(([id, d]) => ({ id, url: d.url, title: d.title ?? null, line: d.line }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    deps: [...doc.getDependencies().entries()]
      .map(([id, set]) => ({ id, nodes: [...set].map((n) => indexById.get(n)).sort((a, b) => a! - b!) }))
      .sort((x, y) => x.id.localeCompare(y.id)),
  };
}

for (const seed of [1, 7, 42, 2026]) {
  test(`random line edits match a full re-parse (seed ${seed})`, () => {
    const rnd = rng(seed);
    const lines = randomLines(rnd, 40);
    const doc = new Document(lines.join('\n'));

    for (let round = 0; round < 250; round++) {
      const lineCount = doc.lineCount();
      const startLine = Math.floor(rnd() * (lineCount + 1));
      const deleteCount = Math.min(lineCount - startLine, Math.floor(rnd() * 4));
      const newLines = randomLines(rnd, Math.floor(rnd() * 4));

      doc.applyEdit(startLine, deleteCount, newLines);

      // Differential check: incremental state vs. a from-scratch parse.
      const oracle = new Document(doc.getText());
      assert.deepEqual(
        snapshot(doc),
        snapshot(oracle),
        `seed=${seed} round=${round} edit=(${startLine}, ${deleteCount}, ${JSON.stringify(newLines)})`,
      );
    }
  });
}
