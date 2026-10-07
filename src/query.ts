import type { El } from "./tree.js";
import { walk } from "./tree.js";
import { nthMatches, type Complex, type Compound, type SelectorList } from "./selector.js";

/** Navigation abstraction so the same matcher runs on the live tree or on the index. */
export interface Nav {
  parentOf(el: El): El | null;
  childrenOf(el: El): readonly El[];
}

export const treeNav: Nav = {
  parentOf: (el) => el.parent,
  childrenOf: (el) => el.children,
};

export function matchesCompound(el: El, c: Compound, nav: Nav): boolean {
  if (c.tag !== null && el.tag !== c.tag) return false;
  for (const cls of c.classes) {
    if (!el.classes.has(cls)) return false;
  }
  for (const cond of c.attrs) {
    const actual = el.attrs.get(cond.name);
    if (actual === undefined) return false;
    if (cond.value !== undefined && actual !== cond.value) return false;
  }
  if (c.nth !== null) {
    const parent = nav.parentOf(el);
    if (parent === null) return false;
    const pos = nav.childrenOf(parent).indexOf(el) + 1;
    if (!nthMatches(pos, c.nth)) return false;
  }
  return true;
}

export function matchesComplex(el: El, sel: Complex, nav: Nav): boolean {
  const last = sel.parts.length - 1;
  if (!matchesCompound(el, sel.parts[last]!, nav)) return false;
  let node = el;
  for (let i = last - 1; i >= 0; i--) {
    const part = sel.parts[i]!;
    if (sel.combs[i] === ">") {
      const parent = nav.parentOf(node);
      if (parent === null || !matchesCompound(parent, part, nav)) return false;
      node = parent;
    } else {
      let cur = nav.parentOf(node);
      while (cur !== null && !matchesCompound(cur, part, nav)) {
        cur = nav.parentOf(cur);
      }
      if (cur === null) return false;
      node = cur;
    }
  }
  return true;
}

/**
 * Reference engine: full tree scan in document order.
 * Each node is visited once, so results are deduplicated and tree-ordered by construction.
 */
export function queryScan(root: El, list: SelectorList): El[] {
  const out: El[] = [];
  for (const el of walk(root)) {
    for (const sel of list) {
      if (matchesComplex(el, sel, treeNav)) {
        out.push(el);
        break;
      }
    }
  }
  return out;
}
