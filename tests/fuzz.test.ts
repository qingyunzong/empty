import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isAncestorOf, walk, type El } from "../src/tree.js";
import { Document } from "../src/index.js";
import { validateIndex } from "../src/validate.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ["div", "span", "p", "li", "em"];
const CLASSES = ["x", "y", "z", "w"];
const ATTRS: Array<[string, string]> = [
  ["data-a", "1"],
  ["data-a", "2"],
  ["data-b", "1"],
  ["title", "t"],
];

function randomElement(rand: () => number): El {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const classes = CLASSES.filter(() => rand() < 0.3);
  const attrs: Record<string, string> = {};
  for (const [name, value] of ATTRS) {
    if (rand() < 0.2) attrs[name] = value;
  }
  return createElement(pick(TAGS), { classes, attrs });
}

function randomSelectors(rand: () => number, count: number): string[] {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const compounds = [
    ...TAGS,
    ...CLASSES.map((c) => `.${c}`),
    "[data-a]",
    '[data-a="1"]',
    "[data-b]",
    "div.x",
    "li:nth-child(1)",
    "li:nth-child(odd)",
    "li:nth-child(even)",
    "li:nth-child(2n+1)",
    "li:nth-child(-n+2)",
    "span:nth-child(3)",
    "p[data-a]",
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const kind = rand();
    if (kind < 0.4) {
      out.push(pick(compounds));
    } else if (kind < 0.7) {
      out.push(`${pick(compounds)} ${pick(compounds)}`);
    } else if (kind < 0.9) {
      out.push(`${pick(compounds)} > ${pick(compounds)}`);
    } else {
      out.push(`${pick(compounds)}, ${pick(compounds)}, ${pick(compounds)}`);
    }
  }
  return out;
}

test("indexed queries match full scan across random insert/move/delete", () => {
  const rand = mulberry32(20261007);
  const doc = new Document();
  const detached: El[] = [];

  const attached = (): El[] => [...walk(doc.root)].filter((el) => el !== doc.root);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

  for (let i = 0; i < 25; i++) {
    doc.appendChild(pick([doc.root, ...attached()]), randomElement(rand));
  }

  const insertRandom = (parent: El, child: El): void => {
    if (parent.children.length > 0 && rand() < 0.5) {
      doc.insertBefore(parent, child, pick(parent.children));
    } else {
      doc.appendChild(parent, child);
    }
  };

  const uids = (els: El[]): number[] => els.map((el) => el.uid);
  let queryChecks = 0;

  for (let step = 0; step < 600; step++) {
    const nodes = attached();
    const roll = rand();
    if (roll < 0.35 || nodes.length === 0) {
      const parent = pick([doc.root, ...nodes]);
      const child = detached.length > 0 && rand() < 0.5 ? detached.pop()! : randomElement(rand);
      insertRandom(parent, child);
    } else if (roll < 0.65) {
      const child = pick(nodes);
      const targets = [doc.root, ...nodes].filter(
        (n) => n !== child && !isAncestorOf(child, n),
      );
      insertRandom(pick(targets), child);
    } else {
      const child = pick(nodes);
      doc.removeChild(child.parent!, child);
      detached.push(child);
    }

    validateIndex(doc.root, doc.index);

    if (step % 5 === 0) {
      for (const sel of randomSelectors(rand, 6)) {
        assert.deepEqual(uids(doc.query(sel)), uids(doc.queryScan(sel)), `step ${step}: ${sel}`);
        queryChecks++;
      }
    }
  }

  assert.ok(queryChecks > 500, `enough differential checks ran (${queryChecks})`);
  assert.ok(attached().length > 0, "tree is not empty at the end");
});

test("fuzz is deterministic for a fixed seed", () => {
  const build = (): number[] => {
    const rand = mulberry32(7);
    const doc = new Document();
    for (let i = 0; i < 40; i++) {
      const nodes = [...walk(doc.root)];
      doc.appendChild(nodes[Math.floor(rand() * nodes.length)]!, randomElement(rand));
    }
    return doc.query("div, span, li").map((el) => el.tag.charCodeAt(0));
  };
  assert.deepEqual(build(), build());
});
