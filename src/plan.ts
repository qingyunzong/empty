import { parseSelector } from "./selector.js";
import type { AttrSelector, Combinator } from "./selector.js";
import { preorder, isWithin } from "./dom.js";
import type { ElementNode } from "./dom.js";

/** One compound in a compiled chain. steps[0] is the subject (rightmost)
 *  compound; steps[i].combinator describes how to reach steps[i+1]
 *  (walking towards ancestors) from steps[i]. */
export interface PlanStep {
  readonly combinator: Combinator | null;
  readonly tag: string | null;
  readonly attrs: readonly AttrSelector[];
}

export interface PlanComplex {
  readonly steps: readonly PlanStep[];
}

/**
 * A compiled, reusable query plan. Compile once with {@link compile} and run
 * against any scope any number of times.
 */
export interface Plan {
  readonly source: string;
  readonly complexes: readonly PlanComplex[];
  /** Test a single node. Ancestor traversal never crosses `scope`. */
  matches(node: ElementNode, scope: ElementNode): boolean;
  /** All matching nodes in `scope`'s subtree (scope included), in document
   *  order, deduplicated across union branches. */
  query(scope: ElementNode): ElementNode[];
}

export function matchCompound(
  node: ElementNode,
  tag: string | null,
  attrs: readonly AttrSelector[],
): boolean {
  if (tag !== null && node.tag !== tag) return false;
  for (const attr of attrs) {
    const actual = node.attributes.get(attr.name);
    if (actual === undefined) return false;
    if (attr.value !== null && actual !== attr.value) return false;
  }
  return true;
}

function matchesStep(node: ElementNode, scope: ElementNode, steps: readonly PlanStep[], i: number): boolean {
  const step = steps[i];
  if (step === undefined) return false;
  if (!matchCompound(node, step.tag, step.attrs)) return false;
  const next = steps[i + 1];
  if (next === undefined) return true;
  if (step.combinator === "child") {
    const p = node.parent;
    return p !== null && isWithin(p, scope) && matchesStep(p, scope, steps, i + 1);
  }
  // descendant: try every ancestor up to and including the scope root
  let p = node.parent;
  while (p !== null && isWithin(p, scope)) {
    if (matchesStep(p, scope, steps, i + 1)) return true;
    p = p.parent;
  }
  return false;
}

/** Compile a selector list into a reusable plan. Throws SelectorSyntaxError on invalid input. */
export function compile(source: string): Plan {
  const ast = parseSelector(source);
  const complexes: PlanComplex[] = ast.complexes.map((complex) => {
    const steps: PlanStep[] = [];
    for (let i = complex.compounds.length - 1; i >= 0; i--) {
      const compound = complex.compounds[i];
      if (compound === undefined) continue;
      const combinator = i === 0 ? null : (complex.combinators[i - 1] ?? null);
      steps.push({ combinator, tag: compound.tag, attrs: compound.attrs });
    }
    return { steps };
  });

  return {
    source,
    complexes,
    matches(node, scope) {
      for (const complex of complexes) {
        if (matchesStep(node, scope, complex.steps, 0)) return true;
      }
      return false;
    },
    query(scope) {
      const out: ElementNode[] = [];
      for (const node of preorder(scope)) {
        if (this.matches(node, scope)) out.push(node);
      }
      return out;
    },
  };
}
