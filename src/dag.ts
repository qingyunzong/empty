export type DagNode =
  | { kind: "source" }
  | { kind: "const"; value: number }
  | { kind: "add"; deps: string[] }
  | { kind: "mul"; deps: string[] }
  | { kind: "cond"; pick: string; then: string; else: string };

export interface DagEvaluation {
  /** Weights of the nodes that were actually evaluated. */
  weights: Map<string, number>;
  /** Names of every node that was evaluated, for branch-selection checks. */
  evaluated: Set<string>;
}

/**
 * Dependency DAG that derives observation weights.
 *
 * Evaluation is lazy: only nodes reachable from the requested targets are
 * computed, and a conditional node evaluates only its selected branch
 * (`then` when the picked node is > 0, otherwise `else`).
 */
export class WeightedDag {
  private readonly nodes: ReadonlyMap<string, DagNode>;

  constructor(nodes: Record<string, DagNode>) {
    this.nodes = new Map(Object.entries(nodes));
  }

  has(name: string): boolean {
    return this.nodes.has(name);
  }

  names(): string[] {
    return [...this.nodes.keys()];
  }

  evaluate(sources: Readonly<Record<string, number>>, targets: string[]): DagEvaluation {
    const weights = new Map<string, number>();
    const evaluated = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string): number => {
      const cached = weights.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const node = this.nodes.get(name);
      if (node === undefined) {
        throw new Error(`unknown node: ${name}`);
      }
      if (visiting.has(name)) {
        throw new Error(`cycle detected at node: ${name}`);
      }
      visiting.add(name);
      evaluated.add(name);
      let value: number;
      switch (node.kind) {
        case "source": {
          const v = sources[name];
          if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error(`missing source value: ${name}`);
          }
          value = v;
          break;
        }
        case "const":
          value = node.value;
          break;
        case "add":
          value = node.deps.reduce((acc, dep) => acc + visit(dep), 0);
          break;
        case "mul":
          value = node.deps.reduce((acc, dep) => acc * visit(dep), 1);
          break;
        case "cond": {
          const picked = visit(node.pick) > 0 ? node.then : node.else;
          value = visit(picked);
          break;
        }
      }
      visiting.delete(name);
      weights.set(name, value);
      return value;
    };

    for (const target of targets) {
      visit(target);
    }
    return { weights, evaluated };
  }
}
