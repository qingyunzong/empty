import * as assert from "node:assert/strict";
import { Document, ElementNode } from "../src/index.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, arr: readonly T[]): T {
  const v = arr[Math.floor(rand() * arr.length)];
  if (v === undefined) throw new Error("pick from empty array");
  return v;
}

export const TAGS = ["div", "span", "p", "ul", "li", "a", "section"] as const;
export const ATTRS = ["data-x", "data-y", "data-z"] as const;
export const VALS = ["1", "2", "3"] as const;

/** Build a random tree under doc.root; every node gets a unique `id` attribute. */
export function buildRandomTree(
  doc: Document,
  rand: () => number,
  nodeCount: number,
): ElementNode[] {
  const all: ElementNode[] = [doc.root];
  doc.root.attributes.set("id", "n0");
  for (let i = 1; i <= nodeCount; i++) {
    const node = doc.createElement(pick(rand, TAGS));
    node.attributes.set("id", `n${i}`);
    for (const attr of ATTRS) {
      if (rand() < 0.35) node.attributes.set(attr, pick(rand, VALS));
    }
    const parent = pick(rand, all);
    doc.appendChild(parent, node);
    all.push(node);
  }
  return all;
}

function randomCompound(rand: () => number): string {
  let out = "";
  if (rand() < 0.7) out += pick(rand, TAGS);
  const attrCount = Math.floor(rand() * 3); // 0..2
  for (let i = 0; i < attrCount; i++) {
    const name = pick(rand, ATTRS);
    if (rand() < 0.25) {
      out += `[${name}]`;
    } else if (rand() < 0.5) {
      out += `[${name}=${pick(rand, VALS)}]`;
    } else {
      out += `[${name}="${pick(rand, VALS)}"]`;
    }
  }
  if (out === "") out = pick(rand, TAGS);
  return out;
}

export function randomSelector(rand: () => number): string {
  const complexCount = 1 + Math.floor(rand() * 2); // 1..2
  const complexes: string[] = [];
  for (let c = 0; c < complexCount; c++) {
    const compoundCount = 1 + Math.floor(rand() * 3); // 1..3
    const compounds: string[] = [];
    for (let i = 0; i < compoundCount; i++) compounds.push(randomCompound(rand));
    let s = compounds[0] ?? "";
    for (let i = 1; i < compounds.length; i++) {
      s += rand() < 0.5 ? " > " : " ";
      s += compounds[i];
    }
    complexes.push(s);
  }
  return complexes.join(", ");
}

export function ids(nodes: readonly ElementNode[]): (string | undefined)[] {
  return nodes.map((n) => n.getAttribute("id"));
}

export function assertSameNodes(
  actual: readonly ElementNode[],
  expected: readonly ElementNode[],
  message?: string,
): void {
  assert.equal(
    actual.length,
    expected.length,
    `${message ?? "node list"}: length ${actual.length} != ${expected.length} ` +
      `(actual=[${ids(actual)}] expected=[${ids(expected)}])`,
  );
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      actual[i] === expected[i],
      `${message ?? "node list"}: index ${i} differs (actual=[${ids(actual)}] expected=[${ids(expected)}])`,
    );
  }
}
