/** Parse tree nodes. Internal nodes record the applied rule; leaves are terminals. */

export interface RuleNode {
  /** Rule applied at this node. */
  ruleId: number;
  /** Nonterminal this node expands (equals the rule's lhs). */
  symbol: string;
  /** One child per rhs symbol of the applied rule, in order. */
  children: TreeNode[];
}

export interface TerminalNode {
  terminal: string;
}

export type TreeNode = RuleNode | TerminalNode;

export function isRuleNode(node: TreeNode): node is RuleNode {
  return (node as RuleNode).ruleId !== undefined;
}

/** Rule IDs in preorder = the leftmost derivation's rule sequence. */
export function preorderRuleIds(root: RuleNode): number[] {
  const out: number[] = [];
  const walk = (node: TreeNode): void => {
    if (isRuleNode(node)) {
      out.push(node.ruleId);
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  return out;
}

/** Yield (terminal sequence) of a tree. */
export function treeYield(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode): void => {
    if (isRuleNode(node)) {
      for (const child of node.children) walk(child);
    } else {
      out.push(node.terminal);
    }
  };
  walk(root);
  return out;
}

/** Total cost of a tree = sum of the costs of every applied rule. */
export function treeCost(root: RuleNode, costOf: (ruleId: number) => number): number {
  let total = 0;
  const walk = (node: TreeNode): void => {
    if (isRuleNode(node)) {
      total += costOf(node.ruleId);
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  return total;
}

/** Depth of a tree (root has depth 1). */
export function treeDepth(root: TreeNode): number {
  if (!isRuleNode(root)) return 0;
  let best = 0;
  for (const child of root.children) {
    const d = treeDepth(child);
    if (d > best) best = d;
  }
  return best + 1;
}
