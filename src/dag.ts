/**
 * Multi-parent commit DAG ("version gallery").
 *
 * - Commits may have any number of parents (0 = root, 2+ = merge).
 * - Incremental insertion rejects anything that would close a cycle.
 * - Nearest common ancestors (NCA / "lowest" common ancestors): common
 *   ancestors that have no *closer* common descendant, i.e. minimal elements
 *   of the common-ancestor set under the descendant order.
 * - Ancestor relations are exported as verifiable path certificates.
 */

export interface AncestorCertificate {
  kind: "ancestor";
  ancestor: string;
  descendant: string;
  /** Witness path: descendant -> ... -> ancestor, following parent edges. */
  path: string[];
}

export interface LcaCertificate {
  kind: "lca";
  bases: string[];
  lcas: string[];
  /** paths[lca][base] = witness path base -> ... -> lca. */
  paths: Record<string, Record<string, string[]>>;
}

export class DagError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "DagError";
  }
}
export class CycleError extends DagError {
  constructor(message?: string) {
    super(message);
    this.name = "CycleError";
  }
}

export class CommitDag {
  #parents = new Map<string, string[]>();
  #children = new Map<string, string[]>();

  get size(): number {
    return this.#parents.size;
  }

  has(id: string): boolean {
    return this.#parents.has(id);
  }

  commits(): string[] {
    return [...this.#parents.keys()];
  }

  parents(id: string): string[] {
    const p = this.#parents.get(id);
    if (p === undefined) throw new DagError(`unknown commit: ${id}`);
    return [...p];
  }

  children(id: string): string[] {
    const c = this.#children.get(id);
    if (c === undefined) throw new DagError(`unknown commit: ${id}`);
    return [...c];
  }

  /**
   * Would adding edges `id -> parents` close a cycle?
   * A cycle appears iff `id` is already reachable from one of the parents
   * by following parent edges (i.e. id is an inclusive ancestor of a parent),
   * or if id is its own parent.
   */
  createsCycle(id: string, parents: string[]): boolean {
    for (const p of parents) {
      if (p === id) return true;
      if (this.#parents.has(p) && this.ancestors(p).has(id)) return true;
    }
    return false;
  }

  /** Incrementally insert a commit. Rejects duplicates, dangling parents,
   *  repeated parents, and anything that would create a cycle. */
  addCommit(id: string, parents: string[] = []): void {
    if (typeof id !== "string" || id.length === 0) {
      throw new DagError("commit id must be a non-empty string");
    }
    if (this.#parents.has(id)) {
      throw new DagError(`duplicate commit: ${id}`);
    }
    if (new Set(parents).size !== parents.length) {
      throw new DagError(`duplicate parents for commit: ${id}`);
    }
    if (this.createsCycle(id, parents)) {
      throw new CycleError(`adding ${id} with parents [${parents}] would create a cycle`);
    }
    for (const p of parents) {
      if (!this.#parents.has(p)) {
        throw new DagError(`unknown parent ${p} for commit: ${id}`);
      }
    }
    this.#parents.set(id, [...parents]);
    this.#children.set(id, []);
    for (const p of parents) this.#children.get(p)!.push(id);
  }

  /** Inclusive ancestor set: the commit itself plus everything reachable
   *  by following parent edges. */
  ancestors(id: string): Set<string> {
    if (!this.#parents.has(id)) throw new DagError(`unknown commit: ${id}`);
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.#parents.get(cur)!) stack.push(p);
    }
    return seen;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.ancestors(descendant).has(ancestor);
  }

  /**
   * All nearest common ancestors of `bases`: commits that are (inclusive)
   * ancestors of every base and have no closer common descendant — no other
   * common ancestor is a proper descendant of them.
   */
  lowestCommonAncestors(bases: string[]): string[] {
    if (bases.length === 0) throw new DagError("need at least one base");
    const sets = bases.map((b) => this.ancestors(b));
    const common = [...sets[0]].filter((c) => sets.every((s) => s.has(c)));
    const commonSets = new Map(common.map((c) => [c, this.ancestors(c)]));
    return common.filter((c) =>
      common.every((other) => other === c || !commonSets.get(other)!.has(c)),
    );
  }

  /** BFS shortest witness path from `from` up to `to` via parent edges,
   *  or null if `to` is not an ancestor of `from`. */
  findPathUp(from: string, to: string): string[] | null {
    if (!this.#parents.has(from) || !this.#parents.has(to)) {
      throw new DagError(`unknown commit in path query: ${from} -> ${to}`);
    }
    const prev = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (cur === to) {
        const path: string[] = [];
        for (let n: string | null = to; n !== null; n = prev.get(n)!) path.unshift(n);
        return path;
      }
      for (const p of this.#parents.get(cur)!) {
        if (!prev.has(p)) {
          prev.set(p, cur);
          queue.push(p);
        }
      }
    }
    return null;
  }

  /** Export a certificate proving `ancestor` is an ancestor of `descendant`. */
  ancestorCertificate(ancestor: string, descendant: string): AncestorCertificate {
    const path = this.findPathUp(descendant, ancestor);
    if (path === null) {
      throw new DagError(`${ancestor} is not an ancestor of ${descendant}`);
    }
    return { kind: "ancestor", ancestor, descendant, path };
  }

  /** Verify an ancestor certificate against this DAG. */
  verifyAncestorCertificate(cert: AncestorCertificate): boolean {
    if (cert.kind !== "ancestor") return false;
    const { ancestor, descendant, path } = cert;
    if (!this.#parents.has(ancestor) || !this.#parents.has(descendant)) return false;
    if (path.length === 0) return false;
    if (path[0] !== descendant || path[path.length - 1] !== ancestor) return false;
    for (let i = 0; i + 1 < path.length; i++) {
      const ps = this.#parents.get(path[i]);
      if (ps === undefined || !ps.includes(path[i + 1])) return false;
    }
    return true;
  }

  /** Export a certificate for the full NCA set of `bases`: the LCA list plus
   *  a witness path from every base up to every LCA. */
  lcaCertificate(bases: string[]): LcaCertificate {
    const lcas = this.lowestCommonAncestors(bases);
    const paths: Record<string, Record<string, string[]>> = {};
    for (const lca of lcas) {
      paths[lca] = {};
      for (const base of bases) {
        const p = this.findPathUp(base, lca);
        if (p === null) throw new DagError("internal: LCA not reachable from base");
        paths[lca][base] = p;
      }
    }
    return { kind: "lca", bases: [...bases], lcas, paths };
  }

  /** Verify an LCA certificate: the claimed LCA set must equal the
   *  recomputed set, and every embedded witness path must check out. */
  verifyLcaCertificate(cert: LcaCertificate): boolean {
    if (cert.kind !== "lca") return false;
    let expected: string[];
    try {
      expected = this.lowestCommonAncestors(cert.bases);
    } catch {
      return false;
    }
    if (cert.lcas.length !== expected.length) return false;
    const claimed = new Set(cert.lcas);
    if (claimed.size !== cert.lcas.length) return false;
    for (const lca of expected) if (!claimed.has(lca)) return false;
    for (const lca of cert.lcas) {
      const perBase = cert.paths[lca];
      if (perBase === undefined) return false;
      for (const base of cert.bases) {
        const path = perBase[base];
        if (path === undefined) return false;
        if (!this.verifyAncestorCertificate({ kind: "ancestor", ancestor: lca, descendant: base, path })) {
          return false;
        }
      }
    }
    return true;
  }

  /** Plain parent table, e.g. for cross-checking against the model. */
  snapshot(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, ps] of this.#parents) out[id] = [...ps];
    return out;
  }
}
