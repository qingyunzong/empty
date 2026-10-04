import type { ArmId } from "./model";

export type WaitEdge = [ArmId, ArmId];

/** Build an adjacency map from wait-for edges. */
export function adjacency(edges: WaitEdge[]): Map<ArmId, ArmId[]> {
  const adj = new Map<ArmId, ArmId[]>();
  for (const [from, to] of edges) {
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
    if (!adj.has(to)) adj.set(to, []);
  }
  return adj;
}

/** Find one cycle in the wait-for graph, or null if acyclic. */
export function findCycle(edges: WaitEdge[]): ArmId[] | null {
  const adj = adjacency(edges);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<ArmId, number>();
  for (const node of adj.keys()) color.set(node, WHITE);
  const stack: ArmId[] = [];

  const dfs = (node: ArmId): ArmId[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        return stack.slice(stack.indexOf(next)).concat(next);
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

/** Human-readable adjacency listing of the wait-for graph. */
export function formatGraph(edges: WaitEdge[], cycle?: ArmId[] | null): string {
  const adj = adjacency(edges);
  const lines: string[] = ["wait-for graph:"];
  if (adj.size === 0) lines.push("  (empty)");
  for (const [node, targets] of [...adj.entries()].sort()) {
    lines.push(`  ${node} -> ${targets.length ? targets.join(", ") : "(none)"}`);
  }
  if (cycle && cycle.length > 0) {
    lines.push(`circular wait detected: ${cycle.join(" -> ")}`);
  }
  return lines.join("\n");
}

/** Graphviz DOT rendering; cycle edges are highlighted in red. */
export function toDot(edges: WaitEdge[], cycle?: ArmId[] | null): string {
  const inCycle = new Set<string>();
  if (cycle) {
    for (let i = 0; i + 1 < cycle.length; i++) {
      inCycle.add(`${cycle[i]}->${cycle[i + 1]}`);
    }
  }
  const lines = ["digraph wait_for {", "  rankdir=LR;"];
  const nodes = new Set<ArmId>();
  for (const [a, b] of edges) { nodes.add(a); nodes.add(b); }
  for (const n of [...nodes].sort()) lines.push(`  "${n}";`);
  for (const [a, b] of edges) {
    const hot = inCycle.has(`${a}->${b}`);
    lines.push(`  "${a}" -> "${b}"${hot ? " [color=red,penwidth=2]" : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
}
