/**
 * Program compilation: range-restriction (safety) checks, predicate arity
 * checks, dependency-graph construction, negative-cycle rejection with an
 * explicit cycle path, and stratum assignment for stratified evaluation.
 */

import { Atom, Rule } from "./core.js";

export class CompileError extends Error {}

export interface CompiledProgram {
  readonly rules: readonly Rule[];
  /** Rules grouped by stratum; index 0 is unused (EDB-only predicates). */
  readonly strata: readonly (readonly Rule[])[];
  /** Stratum of every predicate; EDB-only predicates are stratum 0. */
  readonly predStratum: ReadonlyMap<string, number>;
  /** For each body predicate, the strata of the rules that consume it. */
  readonly consumerStrata: ReadonlyMap<string, ReadonlySet<number>>;
  readonly predArity: ReadonlyMap<string, number>;
}

interface Edge {
  readonly to: string;
  readonly negated: boolean;
}

function* atomVars(a: Atom): Generator<string> {
  for (const t of a.args) if (t.kind === "var") yield t.name;
}

function checkSafety(rule: Rule): void {
  const bound = new Set<string>();
  for (const lit of rule.posBody) for (const v of atomVars(lit.atom)) bound.add(v);
  const requireBound = (vars: Iterable<string>, where: string) => {
    for (const v of vars) {
      if (!bound.has(v))
        throw new CompileError(
          `unsafe rule ${rule.text} variable '${v}' in ${where} does not appear in a positive body literal`,
        );
    }
  };
  requireBound(atomVars(rule.head), "the head");
  for (const lit of rule.negBody)
    requireBound(atomVars(lit.atom), `negative literal 'not ${lit.atom.pred}(...)'`);
}

function checkArity(rules: readonly Rule[]): Map<string, number> {
  const arity = new Map<string, number>();
  const note = (pred: string, n: number, where: string) => {
    const prev = arity.get(pred);
    if (prev === undefined) arity.set(pred, n);
    else if (prev !== n)
      throw new CompileError(
        `predicate '${pred}' used with arity ${n} in ${where} but arity ${prev} elsewhere`,
      );
  };
  for (const r of rules) {
    note(r.head.pred, r.head.args.length, `head of ${r.text}`);
    for (const lit of r.body)
      note(lit.atom.pred, lit.atom.args.length, `body of ${r.text}`);
  }
  return arity;
}

/** Tarjan's SCC algorithm (iterative). Returns component id per predicate. */
function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly Edge[]>,
): Map<string, number> {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let nextIndex = 0;
  let nextComp = 0;

  interface Frame {
    node: string;
    childIdx: number;
  }
  for (const root of nodes) {
    if (index.has(root)) continue;
    const callStack: Frame[] = [{ node: root, childIdx: 0 }];
    index.set(root, nextIndex);
    lowlink.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const succ = edges.get(frame.node) ?? [];
      if (frame.childIdx < succ.length) {
        const edge = succ[frame.childIdx++]!;
        if (!index.has(edge.to)) {
          index.set(edge.to, nextIndex);
          lowlink.set(edge.to, nextIndex);
          nextIndex++;
          stack.push(edge.to);
          onStack.add(edge.to);
          callStack.push({ node: edge.to, childIdx: 0 });
        } else if (onStack.has(edge.to)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, index.get(edge.to)!),
          );
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
          );
        }
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, nextComp);
            if (w === frame.node) break;
          }
          nextComp++;
        }
      }
    }
  }
  return comp;
}

/**
 * Find a dependency cycle that traverses the given negative edge, as a list
 * of predicate names `a -> b -> ... -> a`. Only called when the edge's
 * endpoints share an SCC, so a return path always exists.
 */
function findNegativeCycle(
  from: string,
  to: string,
  edges: ReadonlyMap<string, readonly Edge[]>,
  comp: ReadonlyMap<string, number>,
): string[] {
  const target = comp.get(from)!;
  // BFS from `to` back to `from`, staying inside the SCC.
  const prev = new Map<string, string>();
  const queue: string[] = [to];
  const seen = new Set([to]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === from) break;
    for (const e of edges.get(cur) ?? []) {
      if (comp.get(e.to) !== target || seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, cur);
      queue.push(e.to);
    }
  }
  // Walk the parent chain from `from` back to `to`, then reverse to obtain
  // the path to ~> from; the negative edge from -> to closes the cycle.
  const back: string[] = [from];
  let cur = from;
  while (cur !== to) {
    cur = prev.get(cur)!;
    back.push(cur);
  }
  back.reverse();
  return [from, ...back];
}

export function compile(rules: readonly Rule[]): CompiledProgram {
  for (const rule of rules) checkSafety(rule);
  const predArity = checkArity(rules);

  // Dependency graph: head predicate depends on each body predicate.
  const edges = new Map<string, Edge[]>();
  const addEdge = (from: string, to: string, negated: boolean) => {
    let list = edges.get(from);
    if (!list) edges.set(from, (list = []));
    list.push({ to, negated });
  };
  const nodes = new Set<string>();
  for (const rule of rules) {
    nodes.add(rule.head.pred);
    for (const lit of rule.body) {
      nodes.add(lit.atom.pred);
      addEdge(rule.head.pred, lit.atom.pred, lit.negated);
    }
  }

  const nodeList = [...nodes].sort();
  const comp = stronglyConnectedComponents(nodeList, edges);

  // Reject any negative edge whose endpoints share a component, and report
  // the concrete cycle path through that edge.
  for (const rule of rules) {
    for (const lit of rule.body) {
      if (!lit.negated) continue;
      const from = rule.head.pred;
      const to = lit.atom.pred;
      if (comp.get(from) === comp.get(to)) {
        const cycle = findNegativeCycle(from, to, edges, comp);
        throw new CompileError(
          `unstratifiable program: negative dependency cycle ${cycle.join(" -> ")} ` +
            `(rule ${rule.text} uses 'not ${lit.atom.pred}(...)' inside its own stratum)`,
        );
      }
    }
  }

  // Stratum of a component = longest path from a source component.
  const compOf = (p: string) => comp.get(p)!;
  const compPreds = new Map<number, Set<number>>();
  for (const [from, list] of edges) {
    for (const e of list) {
      const a = compOf(from);
      const b = compOf(e.to);
      if (a === b) continue;
      let s = compPreds.get(a);
      if (!s) compPreds.set(a, (s = new Set()));
      s.add(b);
    }
  }
  const compStratum = new Map<number, number>();
  const stratumOf = (c: number): number => {
    const memo = compStratum.get(c);
    if (memo !== undefined) return memo;
    let s = 0;
    for (const pred of compPreds.get(c) ?? []) s = Math.max(s, stratumOf(pred) + 1);
    compStratum.set(c, s);
    return s;
  };

  const predStratum = new Map<string, number>();
  const headPreds = new Set(rules.map((r) => r.head.pred));
  for (const p of nodeList) predStratum.set(p, headPreds.has(p) ? stratumOf(compOf(p)) : 0);

  const maxStratum = Math.max(0, ...predStratum.values());
  const strata: Rule[][] = Array.from({ length: maxStratum + 1 }, () => []);
  for (const rule of rules) strata[predStratum.get(rule.head.pred)!]!.push(rule);

  const consumerStrata = new Map<string, Set<number>>();
  for (const rule of rules) {
    const s = predStratum.get(rule.head.pred)!;
    for (const lit of rule.body) {
      let set = consumerStrata.get(lit.atom.pred);
      if (!set) consumerStrata.set(lit.atom.pred, (set = new Set()));
      set.add(s);
    }
  }

  return { rules, strata, predStratum, consumerStrata, predArity };
}
