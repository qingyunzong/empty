import { parseSelector } from "./selector.js";
import type { ComplexSelector, Compound } from "./selector.js";
import { preorder, isWithin } from "./dom.js";
import type { ElementNode } from "./dom.js";

/**
 * Naive recursive reference implementation, written directly against the AST
 * (no compiled plan). Used to cross-check the compiled plan and the live
 * incremental engine.
 */

function matchCompoundDirect(node: ElementNode, compound: Compound): boolean {
  if (compound.tag !== null && node.tag !== compound.tag) return false;
  for (const attr of compound.attrs) {
    const actual = node.attributes.get(attr.name);
    if (actual === undefined) return false;
    if (attr.value !== null && actual !== attr.value) return false;
  }
  return true;
}

function matchComplexAt(
  node: ElementNode,
  scope: ElementNode,
  complex: ComplexSelector,
  idx: number,
): boolean {
  const compound = complex.compounds[idx];
  if (compound === undefined) return false;
  if (!matchCompoundDirect(node, compound)) return false;
  if (idx === 0) return true;
  const combinator = complex.combinators[idx - 1];
  if (combinator === "child") {
    const p = node.parent;
    return p !== null && isWithin(p, scope) && matchComplexAt(p, scope, complex, idx - 1);
  }
  let p = node.parent;
  while (p !== null && isWithin(p, scope)) {
    if (matchComplexAt(p, scope, complex, idx - 1)) return true;
    p = p.parent;
  }
  return false;
}

/** Full re-match of `source` against `scope`'s subtree, document order, deduplicated. */
export function naiveQuery(scope: ElementNode, source: string): ElementNode[] {
  const list = parseSelector(source);
  const out: ElementNode[] = [];
  const seen = new Set<ElementNode>();
  for (const node of preorder(scope)) {
    for (const complex of list.complexes) {
      if (matchComplexAt(node, scope, complex, complex.compounds.length - 1)) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
        break;
      }
    }
  }
  return out;
}
