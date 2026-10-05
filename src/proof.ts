import { evalNaive, exprToString, varsOf } from "./expr.js";
import type { NamedConstraint } from "./solver.js";

// Unsatisfiability proof tree: a complete case analysis over the core's
// variables. Every internal node splits on one variable; every leaf is a
// constraint of the core that is falsified by the partial assignment along
// the path. Because the core is unsatisfiable, every branch closes, so the
// tree is a complete refutation.

export type ProofNode =
  | { type: "contradiction"; constraint: string }
  | { type: "split"; variable: string; onFalse: ProofNode; onTrue: ProofNode };

export function buildProofTree(core: NamedConstraint[], vars: string[]): ProofNode {
  const sorted = core
    .map((c) => ({ name: c.name, expr: c.expr, vars: varsOf(c.expr) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const env = new Map<string, boolean>();

  const build = (varIdx: number): ProofNode => {
    for (const c of sorted) {
      if (c.vars.every((v) => env.has(v)) && !evalNaive(c.expr, (name) => env.get(name)!)) {
        return { type: "contradiction", constraint: c.name };
      }
    }
    if (varIdx >= vars.length) {
      // Unreachable for a genuinely unsatisfiable core; keeps the type total.
      throw new Error("proof tree construction reached a non-contradictory full assignment");
    }
    const variable = vars[varIdx];
    env.set(variable, false);
    const onFalse = build(varIdx + 1);
    env.set(variable, true);
    const onTrue = build(varIdx + 1);
    env.delete(variable);
    return { type: "split", variable, onFalse, onTrue };
  };

  return build(0);
}

export function countLeaves(node: ProofNode): number {
  return node.type === "contradiction" ? 1 : countLeaves(node.onFalse) + countLeaves(node.onTrue);
}

export function renderProofTree(root: ProofNode, core: string[], maxLeaves = 512): string {
  const leaves = countLeaves(root);
  const header = `proof tree (minimal unsat core: ${core.join(", ")}; ${leaves} contradiction leaves)`;
  if (leaves > maxLeaves) {
    return `${header}\n  [tree too large to display: ${leaves} leaves exceed the display budget of ${maxLeaves}]`;
  }
  const lines: string[] = [header];
  const walk = (node: ProofNode, indent: string, edge: string | null): void => {
    if (node.type === "contradiction") {
      lines.push(`${indent}${edge ?? ""}CONTRADICTION ${node.constraint}`);
      return;
    }
    lines.push(`${indent}${edge ?? ""}split ${node.variable}`);
    walk(node.onFalse, indent + "  ", `${node.variable}=0 -> `);
    walk(node.onTrue, indent + "  ", `${node.variable}=1 -> `);
  };
  walk(root, "  ", null);
  return lines.join("\n");
}

// Independent structural validation of a proof tree, used by the verifier:
// replays every root-to-leaf path with the naive evaluator and confirms that
// each leaf's constraint is genuinely falsified by the path's assignment and
// that the tree is a complete binary case split.
export function validateProofTree(
  root: ProofNode,
  core: NamedConstraint[],
  vars: string[],
): { ok: boolean; detail: string } {
  const byName = new Map(core.map((c) => [c.name, c]));
  const coreVarSet = new Set(vars);
  const seenSplitVars: string[] = [];
  let leaves = 0;

  const walk = (node: ProofNode, env: Map<string, boolean>, depth: number): string | null => {
    if (node.type === "contradiction") {
      const constraint = byName.get(node.constraint);
      if (!constraint) return `leaf references constraint '${node.constraint}' outside the core`;
      const cVars = varsOf(constraint.expr);
      if (!cVars.every((v) => env.has(v))) {
        return `leaf '${node.constraint}' is not fully determined by its path assignment`;
      }
      if (evalNaive(constraint.expr, (name) => env.get(name)!)) {
        return `leaf '${node.constraint}' is actually satisfied by its path assignment`;
      }
      leaves++;
      return null;
    }
    if (!coreVarSet.has(node.variable)) {
      return `split on '${node.variable}' which is not a core variable`;
    }
    if (seenSplitVars.includes(node.variable)) {
      // A variable may legitimately appear on different branches, but never
      // twice on the same root-to-node path.
      return `variable '${node.variable}' split twice on one path`;
    }
    if (depth > vars.length) return "tree deeper than the number of core variables";
    seenSplitVars.push(node.variable);
    env.set(node.variable, false);
    const leftErr = walk(node.onFalse, env, depth + 1);
    env.set(node.variable, true);
    const rightErr = leftErr ?? walk(node.onTrue, env, depth + 1);
    env.delete(node.variable);
    seenSplitVars.pop();
    return leftErr ?? rightErr;
  };

  const err = walk(root, new Map(), 0);
  if (err) return { ok: false, detail: err };
  return { ok: true, detail: `all ${leaves} leaves are genuine contradictions` };
}

export function describeCoreConstraint(c: NamedConstraint): string {
  return `${c.name}: ${exprToString(c.expr)}`;
}
