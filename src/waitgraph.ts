import type { ArmId } from './model.js';

/**
 * Wait-for graph: edge A -> B means arm A is blocked on a segment
 * currently locked by arm B. A cycle is a circular wait (deadlock).
 */
export class WaitGraph {
  private edges = new Map<ArmId, Set<ArmId>>();

  clear(): void {
    this.edges.clear();
  }

  setEdges(from: ArmId, to: Iterable<ArmId>): void {
    const targets = new Set<ArmId>();
    for (const t of to) {
      if (t !== from) targets.add(t);
    }
    if (targets.size > 0) this.edges.set(from, targets);
    else this.edges.delete(from);
  }

  /** Returns a closed cycle like ['r1', 'r2', 'r1'], or null. */
  findCycle(): ArmId[] | null {
    const color = new Map<ArmId, 'gray' | 'black'>();
    const stack: ArmId[] = [];
    const visit = (node: ArmId): ArmId[] | null => {
      color.set(node, 'gray');
      stack.push(node);
      for (const next of [...(this.edges.get(node) ?? [])].sort()) {
        const c = color.get(next);
        if (c === 'gray') {
          return stack.slice(stack.indexOf(next)).concat(next);
        }
        if (c === undefined) {
          const found = visit(next);
          if (found) return found;
        }
      }
      stack.pop();
      color.set(node, 'black');
      return null;
    };
    for (const node of [...this.edges.keys()].sort()) {
      if (!color.has(node)) {
        const found = visit(node);
        if (found) return found;
      }
    }
    return null;
  }

  toAdjacency(): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const [from, targets] of [...this.edges.entries()].sort()) {
      adj[from] = [...targets].sort();
    }
    return adj;
  }

  toDot(): string {
    const lines = ['digraph wait_for {'];
    const nodes = new Set<ArmId>();
    for (const [from, targets] of this.edges) {
      nodes.add(from);
      for (const t of targets) nodes.add(t);
    }
    for (const n of [...nodes].sort()) lines.push(`  "${n}";`);
    for (const [from, targets] of [...this.edges.entries()].sort()) {
      for (const t of [...targets].sort()) lines.push(`  "${from}" -> "${t}";`);
    }
    lines.push('}');
    return lines.join('\n');
  }
}
