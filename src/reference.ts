/**
 * Naive recursive reference implementation.
 *
 * Deliberately written in the most straightforward way possible (recursive
 * backtracking over the parsed AST, no compilation, no caching) so it can
 * serve as a ground-truth oracle for the compiled Plan executor and the
 * incremental live engine.
 */

import { ElementNode } from './dom.js';
import { parseSelector, type Compound, type SelectorChain } from './parser.js';

function compoundMatches(compound: Compound, node: ElementNode): boolean {
  if (compound.tag !== null && compound.tag !== node.tag) return false;
  for (const attr of compound.attrs) {
    if (node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

/** Match a whole chain against a candidate, rightmost compound first. */
function chainMatches(chain: SelectorChain, node: ElementNode, root: ElementNode): boolean {
  const compounds = [chain.first, ...chain.rest.map((s) => s.compound)];
  const combinators = chain.rest.map((s) => s.combinator);

  // Does compounds[i] match `node`, with the remaining prefix chain
  // compounds[0..i-1] matching appropriate ancestors within root?
  function solve(i: number, current: ElementNode): boolean {
    if (!compoundMatches(compounds[i]!, current)) return false;
    if (i === 0) return true;
    const combinator = combinators[i - 1]!;
    if (combinator === 'child') {
      if (current === root || current.parent === null) return false;
      return solve(i - 1, current.parent);
    }
    // descendant: any ancestor up to and including root
    let ancestor = current;
    while (ancestor !== root && ancestor.parent !== null) {
      ancestor = ancestor.parent;
      if (solve(i - 1, ancestor)) return true;
    }
    return false;
  }

  return solve(compounds.length - 1, node);
}

/** Reference: does `node` match `selectorText` within scope `root`? */
export function referenceMatches(selectorText: string, node: ElementNode, root: ElementNode): boolean {
  const selector = parseSelector(selectorText);
  return selector.chains.some((chain) => chainMatches(chain, node, root));
}

/** Reference: full query, document order, deduplicated. */
export function referenceQuery(root: ElementNode, selectorText: string): ElementNode[] {
  const selector = parseSelector(selectorText);
  const seen = new Set<ElementNode>();
  const result: ElementNode[] = [];
  for (const node of root.selfAndDescendants()) {
    if (seen.has(node)) continue;
    if (selector.chains.some((chain) => chainMatches(chain, node, root))) {
      seen.add(node);
      result.push(node);
    }
  }
  return result;
}
