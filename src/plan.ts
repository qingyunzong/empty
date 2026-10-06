/**
 * Compiled, reusable query plans.
 *
 * A Plan is built once from selector text and can be executed against any
 * scope root any number of times. Results are deduplicated and returned in
 * document order. The scope root acts as a hard boundary: ancestor walks
 * (for both '>' and descendant combinators) never look past it, so a scoped
 * query can never match via elements outside the scope.
 */

import { ElementNode } from './dom.js';
import {
  parseSelector,
  type AttrCondition,
  type Combinator,
  type Selector,
} from './parser.js';

interface CompiledStep {
  /** How this step relates to the step before it (unused on step 0). */
  combinator: Combinator;
  tag: string | null;
  attrs: AttrCondition[];
}

interface CompiledChain {
  /** Rightmost compound first: matching walks from candidate up to root. */
  steps: CompiledStep[];
}

export class Plan {
  readonly source: string;
  private readonly chains: CompiledChain[];

  static from(source: string): Plan {
    return new Plan(source, parseSelector(source));
  }

  private constructor(source: string, selector: Selector) {
    this.source = source;
    this.chains = selector.chains.map((chain) => {
      // chain is stored left-to-right (root-ward first); compile to
      // right-to-left so step 0 is the candidate's own compound.
      const all = [chain.first, ...chain.rest.map((s) => s.compound)];
      const combinators = chain.rest.map((s) => s.combinator);
      const steps: CompiledStep[] = [];
      for (let i = all.length - 1; i >= 0; i--) {
        steps.push({
          combinator: i === all.length - 1 ? 'descendant' : combinators[i]!,
          tag: all[i]!.tag,
          attrs: all[i]!.attrs,
        });
      }
      return { steps };
    });
  }

  /**
   * Whether `node` matches this plan within `root`. Ancestor lookups stop
   * at `root` (inclusive); nothing beyond the scope root is consulted.
   */
  matches(node: ElementNode, root: ElementNode): boolean {
    for (const chain of this.chains) {
      if (matchesChain(chain.steps, 0, node, root)) return true;
    }
    return false;
  }

  /**
   * Execute the plan: all matching nodes in `root`'s subtree (including
   * `root` itself), deduplicated, in document order.
   */
  query(root: ElementNode): ElementNode[] {
    const result: ElementNode[] = [];
    for (const node of root.selfAndDescendants()) {
      if (this.matches(node, root)) result.push(node);
    }
    return result;
  }
}

function matchesCompound(step: CompiledStep, node: ElementNode): boolean {
  if (step.tag !== null && step.tag !== node.tag) return false;
  for (const attr of step.attrs) {
    if (node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function matchesChain(
  steps: CompiledStep[],
  index: number,
  node: ElementNode,
  root: ElementNode,
): boolean {
  if (!matchesCompound(steps[index]!, node)) return false;
  if (index === steps.length - 1) return true;
  const next = steps[index + 1]!;
  if (next.combinator === 'child') {
    if (node === root) return false;
    const parent = node.parent;
    if (parent === null) return false;
    return matchesChain(steps, index + 1, parent, root);
  }
  // Descendant: try every ancestor up to and including the scope root.
  let current: ElementNode = node;
  while (current !== root) {
    const parent: ElementNode | null = current.parent;
    if (parent === null) return false;
    if (matchesChain(steps, index + 1, parent, root)) return true;
    current = parent;
  }
  return false;
}

/** Compile selector text into a reusable plan. Throws SelectorSyntaxError. */
export function compile(source: string): Plan {
  return Plan.from(source);
}

/** One-shot convenience: compile + execute. */
export function query(root: ElementNode, selector: string): ElementNode[] {
  return compile(selector).query(root);
}
