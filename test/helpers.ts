import { ElementNode } from '../src/index.js';

/** Seeded PRNG (mulberry32) for reproducible randomized tests. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ['div', 'span', 'p', 'a', 'li'];
const ATTR_NAMES = ['data-x', 'data-y', 'class'];
const ATTR_VALUES = ['1', '2', 'red'];

export function randomTree(rand: () => number, maxDepth = 4, maxChildren = 4): ElementNode {
  const tag = TAGS[Math.floor(rand() * TAGS.length)]!;
  const node = new ElementNode(tag);
  for (const name of ATTR_NAMES) {
    if (rand() < 0.3) {
      node.attributes.set(name, ATTR_VALUES[Math.floor(rand() * ATTR_VALUES.length)]!);
    }
  }
  if (maxDepth > 0) {
    const count = Math.floor(rand() * (maxChildren + 1));
    for (let i = 0; i < count; i++) {
      const child = randomTree(rand, maxDepth - 1, maxChildren);
      node.children.push(child);
      child.parent = node;
    }
  }
  return node;
}

export function randomSelector(rand: () => number): string {
  const compound = (): string => {
    let text = rand() < 0.2 ? '*' : TAGS[Math.floor(rand() * TAGS.length)]!;
    if (rand() < 0.5) {
      const name = ATTR_NAMES[Math.floor(rand() * ATTR_NAMES.length)]!;
      const value = ATTR_VALUES[Math.floor(rand() * ATTR_VALUES.length)]!;
      text += `[${name}="${value}"]`;
    }
    return text;
  };
  const chain = (): string => {
    const parts = [compound()];
    const extra = Math.floor(rand() * 3);
    for (let i = 0; i < extra; i++) {
      parts.push(rand() < 0.5 ? ' > ' : ' ');
      parts.push(compound());
    }
    return parts.join('');
  };
  const chains = [chain()];
  if (rand() < 0.4) chains.push(chain());
  return chains.join(', ');
}
