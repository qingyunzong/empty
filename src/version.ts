import { State } from './types.js';

export interface VersionNode {
  readonly id: number;
  readonly state: State;
  readonly parent: number | null;
  readonly branch: string;
}

/**
 * Append-only store of immutable state versions arranged as a tree.
 * Any version can be forked: the fork starts a new branch at the same
 * state, and later commits on either branch diverge without affecting
 * each other.
 */
export class StateStore {
  private readonly nodes: VersionNode[] = [];

  /** Creates the root version of a new history. */
  create(state: State, branch = 'main'): number {
    return this.push(state, null, branch);
  }

  /** Appends a successor state on the same branch as `from`. */
  commit(from: number, state: State): number {
    const parent = this.node(from);
    return this.push(state, from, parent.branch);
  }

  /** Forks a new branch starting at the same state as `from`. */
  fork(from: number, branch?: string): number {
    const parent = this.node(from);
    const name = branch ?? `${parent.branch}#${from}`;
    return this.push(parent.state, from, name);
  }

  state(id: number): State {
    return this.node(id).state;
  }

  branchOf(id: number): string {
    return this.node(id).branch;
  }

  /** State chain from the root down to `id` (inclusive). */
  history(id: number): State[] {
    const chain: State[] = [];
    let cur: number | null = id;
    while (cur !== null) {
      const n = this.node(cur);
      chain.push(n.state);
      cur = n.parent;
    }
    return chain.reverse();
  }

  /** Version ids of all direct children of `id` (commits and forks). */
  children(id: number): number[] {
    this.node(id);
    return this.nodes.filter((n) => n.parent === id).map((n) => n.id);
  }

  get size(): number {
    return this.nodes.length;
  }

  private push(state: State, parent: number | null, branch: string): number {
    const id = this.nodes.length;
    this.nodes.push({ id, state, parent, branch });
    return id;
  }

  private node(id: number): VersionNode {
    const n = this.nodes[id];
    if (!n) throw new Error(`unknown version ${id}`);
    return n;
  }
}
