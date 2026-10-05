/**
 * Independent brute-force model used to cross-check CommitDag.
 *
 * Computes the FULL reachability (inclusive ancestor) set of every commit by
 * naive fixpoint iteration, then derives nearest common ancestors straight
 * from the definition. Deliberately unoptimized: this is the specification.
 */

export type ParentTable = Record<string, string[]>;

/** Full inclusive reachability sets via fixpoint iteration:
 *  R(v) = {v} ∪ ⋃ R(p) over parents p, iterated until stable. */
export function reachabilitySets(table: ParentTable): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const id of Object.keys(table)) reach.set(id, new Set([id]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parents] of Object.entries(table)) {
      const set = reach.get(id)!;
      for (const p of parents) {
        for (const q of reach.get(p)!) {
          if (!set.has(q)) {
            set.add(q);
            changed = true;
          }
        }
      }
    }
  }
  return reach;
}

export function modelIsAncestor(table: ParentTable, ancestor: string, descendant: string): boolean {
  return reachabilitySets(table).get(descendant)!.has(ancestor);
}

/** Nearest common ancestors per the definition: common ancestors c such that
 *  no other common ancestor is a proper descendant of c. */
export function modelLcas(table: ParentTable, bases: string[]): string[] {
  const reach = reachabilitySets(table);
  const common = [...reach.get(bases[0])!].filter((c) =>
    bases.every((b) => reach.get(b)!.has(c)),
  );
  return common.filter((c) =>
    common.every((other) => other === c || !reach.get(other)!.has(c)),
  );
}
