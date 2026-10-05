import { Literal, Rule, isVar } from "./types.js";

/** A predicate the head predicate depends on through a rule body. */
interface DepEdge {
  /** Predicate being depended upon (body literal predicate). */
  target: string;
  negated: boolean;
}

export interface Stratum {
  /** 1-based layer number; EDB-only predicates live in layer 0. */
  layer: number;
  preds: string[];
  rules: Rule[];
}

export class UnstratifiedError extends Error {
  /** Predicates on the rejected cycle, in dependency order (first == last). */
  readonly cycle: string[];
  constructor(cycle: string[], edges: boolean[]) {
    const rendered = cycle
      .slice(0, -1)
      .map((p, i) => `${p} ${edges[i] ? "-[not]->" : "->"} `)
      .join("") + cycle[cycle.length - 1];
    super(`Unstratifiable program: negative dependency cycle: ${rendered}`);
    this.name = "UnstratifiedError";
    this.cycle = cycle;
  }
}

export class UnsafeRuleError extends Error {
  constructor(rule: Rule, vars: string[]) {
    super(
      `Unsafe rule '${rule.text}': variable(s) ${vars.join(", ")} ` +
        `do not occur in any positive body literal`
    );
    this.name = "UnsafeRuleError";
  }
}

export class ArityError extends Error {
  constructor(pred: string, a: number, b: number) {
    super(`Predicate '${pred}' used with inconsistent arities ${a} and ${b}`);
    this.name = "ArityError";
  }
}

export interface CompiledProgram {
  /** Evaluation order: strata sorted by ascending layer. */
  strata: Stratum[];
  /** layer assigned to each predicate (0 = EDB only). */
  layerOf: Map<string, number>;
}

/**
 * Check rule safety (every head/negated variable is bound by a positive body
 * literal) and predicate arity consistency.
 */
export function checkRules(rules: Rule[], factArities: Map<string, number>): void {
  const arity = new Map<string, number>(factArities);
  const noteArity = (pred: string, n: number) => {
    const prev = arity.get(pred);
    if (prev === undefined) arity.set(pred, n);
    else if (prev !== n) throw new ArityError(pred, prev, n);
  };
  for (const rule of rules) {
    noteArity(rule.head.pred, rule.head.args.length);
    for (const lit of rule.body) noteArity(lit.atom.pred, lit.atom.args.length);
  }
  for (const rule of rules) {
    const bound = new Set<string>();
    for (const lit of rule.body) {
      if (lit.negated) continue;
      for (const arg of lit.atom.args) if (isVar(arg)) bound.add(arg.name);
    }
    const unbound = new Set<string>();
    const need = (lit: { atom: { args: readonly import("./types.js").Term[] } }) => {
      for (const arg of lit.atom.args)
        if (isVar(arg) && !bound.has(arg.name)) unbound.add(arg.name);
    };
    need({ atom: rule.head });
    for (const lit of rule.body) if (lit.negated) need(lit);
    if (unbound.size > 0) throw new UnsafeRuleError(rule, [...unbound]);
  }
}

/**
 * Normalize rule bodies so all positive literals come before negated ones.
 * The join evaluator relies on this order (negation is checked only after
 * every variable is bound by the positive prefix).
 */
export function normalizeBodies(rules: Rule[]): Rule[] {
  return rules.map((r) => {
    const pos = r.body.filter((l) => !l.negated);
    const neg = r.body.filter((l) => l.negated);
    return { ...r, body: [...pos, ...neg] };
  });
}

/**
 * Build the predicate dependency graph, reject programs whose negation is not
 * stratified (reporting an explicit cycle path), and group rules into layers
 * for bottom-up evaluation.
 */
export function stratify(rules: Rule[]): CompiledProgram {
  const deps = new Map<string, DepEdge[]>();
  const ensure = (p: string) => {
    if (!deps.has(p)) deps.set(p, []);
  };
  for (const rule of rules) {
    ensure(rule.head.pred);
    for (const lit of rule.body) {
      ensure(lit.atom.pred);
      deps.get(rule.head.pred)!.push({ target: lit.atom.pred, negated: lit.negated });
    }
  }

  // Tarjan's strongly connected components.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const e of deps.get(v) ?? []) {
      const w = e.target;
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };
  for (const v of deps.keys()) if (!index.has(v)) strongconnect(v);

  const sccOf = new Map<string, number>();
  sccs.forEach((scc, i) => scc.forEach((p) => sccOf.set(p, i)));

  // Reject any SCC that contains a negative edge, reporting the cycle path.
  for (const scc of sccs) {
    const members = new Set(scc);
    for (const u of scc) {
      for (const e of deps.get(u) ?? []) {
        if (!e.negated || !members.has(e.target)) continue;
        // u -[not]-> v, and v reaches u inside the SCC: find that path.
        const path = findPath(deps, members, e.target, u);
        const cycle = [u, ...path];
        const edgeKinds = [true, ...path.slice(0, -1).map((p, i) => isNegEdge(deps, p, path[i + 1] ?? u))];
        throw new UnstratifiedError(cycle, edgeKinds);
      }
    }
  }

  // Condensation DAG: assign layers. Positive dependency keeps the same or a
  // higher layer; a negative dependency forces a strictly higher layer.
  const sccDeps: Array<Set<number>> = sccs.map(() => new Set());
  const sccNegDeps: Array<Set<number>> = sccs.map(() => new Set());
  for (const [pred, edges] of deps) {
    const from = sccOf.get(pred)!;
    for (const e of edges) {
      const to = sccOf.get(e.target)!;
      if (from === to) continue;
      (e.negated ? sccNegDeps[from]! : sccDeps[from]!).add(to);
    }
  }
  const layerOfScc = new Array<number>(sccs.length).fill(-1);
  const layerOf = (i: number): number => {
    if (layerOfScc[i]! >= 0) return layerOfScc[i]!;
    let layer = 1;
    for (const d of sccDeps[i]!) layer = Math.max(layer, layerOf(d));
    for (const d of sccNegDeps[i]!) layer = Math.max(layer, layerOf(d) + 1);
    layerOfScc[i] = layer;
    return layer;
  };
  for (let i = 0; i < sccs.length; i++) layerOf(i);

  const hasRule = new Set(rules.map((r) => r.head.pred));
  const byLayer = new Map<number, Stratum>();
  const layerOfPred = new Map<string, number>();
  sccs.forEach((scc, i) => {
    const ruled = scc.filter((p) => hasRule.has(p));
    for (const p of scc) layerOfPred.set(p, ruled.length > 0 ? layerOfScc[i]! : 0);
    if (ruled.length === 0) return; // EDB-only component
    const layer = layerOfScc[i]!;
    let stratum = byLayer.get(layer);
    if (!stratum) {
      stratum = { layer, preds: [], rules: [] };
      byLayer.set(layer, stratum);
    }
    stratum.preds.push(...ruled);
    stratum.rules.push(...rules.filter((r) => ruled.includes(r.head.pred)));
  });

  const strata = [...byLayer.values()].sort((a, b) => a.layer - b.layer);
  return { strata, layerOf: layerOfPred };
}

/** DFS for a dependency path from `from` to `to` staying inside `members`. */
function findPath(
  deps: Map<string, DepEdge[]>,
  members: Set<string>,
  from: string,
  to: string
): string[] {
  const visited = new Set<string>([from]);
  const dfs = (cur: string, acc: string[]): string[] | null => {
    if (cur === to) return acc;
    for (const e of deps.get(cur) ?? []) {
      if (!members.has(e.target) || visited.has(e.target)) continue;
      visited.add(e.target);
      const r = dfs(e.target, [...acc, e.target]);
      if (r) return r;
    }
    return null;
  };
  const path = dfs(from, [from]);
  if (!path) throw new Error("internal: SCC path not found");
  return path;
}

function isNegEdge(deps: Map<string, DepEdge[]>, from: string, to: string): boolean {
  return (deps.get(from) ?? []).some((e) => e.target === to && e.negated);
}
