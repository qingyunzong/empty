import {
  ArityError,
  CompiledProgram,
  Stratum,
  checkRules,
  normalizeBodies,
  stratify,
} from "./compile.js";
import { ParsedProgram, parseFact, parseProgram } from "./parser.js";
import {
  Atom,
  Const,
  Derivation,
  Fact,
  Rule,
  Term,
  factKey,
  isVar,
  keyOfFact,
} from "./types.js";

export interface Explanation {
  /** null for EDB (base) facts. */
  ruleId: number | null;
  rule: string | null;
  positive: string[];
  negative: string[];
}

export interface FactExplanation {
  fact: string;
  base: boolean;
  derivations: Explanation[];
}

type Subst = Map<string, Const>;

const LINK_SEP = "";

/**
 * A stratified Datalog database with provenance-tracked, incrementally
 * maintained minimal models.
 *
 * - `load` compiles rules (rejecting negative dependency cycles) and
 *   evaluates the minimal model layer by layer (semi-naive fixpoint).
 * - `insert` / `retract` update the model incrementally: derivations carry
 *   their positive and negative antecedents, so retracting a fact cascades
 *   exactly through what it supports, and previously blocked negations are
 *   re-derived afterwards (DRed-style delete + re-derive).
 */
export class InferenceDB {
  private rules: Rule[] = [];
  private compiled: CompiledProgram = { strata: [], layerOf: new Map() };

  private readonly arities = new Map<string, number>();

  private readonly facts = new Map<string, Fact>();
  private readonly byPred = new Map<string, Set<string>>();
  private readonly base = new Set<string>();

  /** fact key -> derivation key -> derivation */
  private readonly derivations = new Map<string, Map<string, Derivation>>();
  /** antecedent key -> set of `${factKey}${derivKey}` back-links */
  private readonly posDependents = new Map<string, Set<string>>();
  private readonly negDependents = new Map<string, Set<string>>();

  /** Replace the whole program (rules + EDB facts) and evaluate it. */
  load(source: string): void {
    const parsed = parseProgram(source);
    this.reset();
    this.arities.clear();
    for (const f of parsed.facts) {
      const prev = this.arities.get(f.pred);
      if (prev !== undefined && prev !== f.args.length)
        throw new ArityError(f.pred, prev, f.args.length);
      this.arities.set(f.pred, f.args.length);
    }
    checkRules(parsed.rules, this.arities);
    for (const rule of parsed.rules) {
      this.arities.set(rule.head.pred, rule.head.args.length);
      for (const lit of rule.body) this.arities.set(lit.atom.pred, lit.atom.args.length);
    }
    this.rules = normalizeBodies(parsed.rules);
    this.compiled = stratify(this.rules);
    for (const f of parsed.facts) this.addBase(f);
    this.reevaluate();
  }

  private checkArity(pred: string, n: number): void {
    const prev = this.arities.get(pred);
    if (prev !== undefined && prev !== n) throw new ArityError(pred, prev, n);
    this.arities.set(pred, n);
  }

  private reset(): void {
    this.facts.clear();
    this.byPred.clear();
    this.base.clear();
    this.derivations.clear();
    this.posDependents.clear();
    this.negDependents.clear();
    this.rules = [];
  }

  /** Insert a base fact; returns false if it was already a base fact. */
  insert(factSrc: string): boolean {
    const f = parseFact(factSrc);
    this.checkArity(f.pred, f.args.length);
    const key = factKey(f.pred, f.args);
    if (this.base.has(key)) return false;
    this.base.add(key);
    if (!this.facts.has(key)) {
      this.addToStore({ pred: f.pred, args: f.args });
      // The new fact may falsify negated literals used by live derivations.
      this.propagate([], [key]);
    }
    this.reevaluate();
    return true;
  }

  /** Retract a base fact; returns false if it was not a base fact. */
  retract(factSrc: string): boolean {
    const f = parseFact(factSrc);
    this.checkArity(f.pred, f.args.length);
    const key = factKey(f.pred, f.args);
    if (!this.base.has(key)) return false;
    this.base.delete(key);
    if ((this.derivations.get(key)?.size ?? 0) === 0) {
      this.removeFromStore(key);
      this.propagate([key], []);
    }
    this.reevaluate();
    return true;
  }

  /** All current fact keys, optionally filtered by predicate, sorted. */
  factsOf(pred?: string): string[] {
    const out: string[] = [];
    if (pred !== undefined) {
      for (const k of this.byPred.get(pred) ?? []) out.push(k);
    } else {
      for (const k of this.facts.keys()) out.push(k);
    }
    return out.sort();
  }

  /** The full minimal model: predicate -> sorted fact keys. */
  model(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [pred, keys] of this.byPred) {
      if (keys.size > 0) out[pred] = [...keys].sort();
    }
    return out;
  }

  /** Current base (EDB) facts, sorted. */
  baseFacts(): string[] {
    return [...this.base].sort();
  }

  /** Layer assigned to each predicate by the stratifier (0 = EDB only). */
  layers(): Record<string, number> {
    return Object.fromEntries(
      [...this.compiled.layerOf.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );
  }

  strataInfo(): { layer: number; preds: string[] }[] {
    return this.compiled.strata.map((s) => ({ layer: s.layer, preds: [...s.preds].sort() }));
  }

  /** Provenance of a fact: its base status plus every live derivation. */
  explain(key: string): FactExplanation | null {
    const norm = this.normalizeKey(key);
    if (!this.facts.has(norm)) return null;
    const derivations: Explanation[] = [];
    for (const d of this.derivations.get(norm)?.values() ?? []) {
      const rule = this.rules[d.ruleId];
      derivations.push({
        ruleId: d.ruleId,
        rule: rule ? rule.text : null,
        positive: [...d.positive],
        negative: [...d.negative],
      });
    }
    return { fact: norm, base: this.base.has(norm), derivations };
  }

  private normalizeKey(key: string): string {
    const f = parseFact(key);
    return factKey(f.pred, f.args);
  }

  // ------------------------------------------------------------------
  // Store maintenance
  // ------------------------------------------------------------------

  private addBase(f: { pred: string; args: Const[] }): void {
    const key = factKey(f.pred, f.args);
    this.base.add(key);
    if (!this.facts.has(key)) this.addToStore({ pred: f.pred, args: f.args });
  }

  private addToStore(f: Fact): void {
    const key = keyOfFact(f);
    this.facts.set(key, f);
    let set = this.byPred.get(f.pred);
    if (!set) {
      set = new Set();
      this.byPred.set(f.pred, set);
    }
    set.add(key);
  }

  private removeFromStore(key: string): void {
    const f = this.facts.get(key);
    if (!f) return;
    this.facts.delete(key);
    const set = this.byPred.get(f.pred);
    if (set) {
      set.delete(key);
      if (set.size === 0) this.byPred.delete(f.pred);
    }
    this.derivations.delete(key);
  }

  private derivKey(d: Derivation): string {
    return `${d.ruleId}|${d.positive.join(",")}|~${d.negative.join(",")}`;
  }

  private recordDerivation(fact: string, d: Derivation): void {
    let map = this.derivations.get(fact);
    if (!map) {
      map = new Map();
      this.derivations.set(fact, map);
    }
    const dk = this.derivKey(d);
    if (map.has(dk)) return;
    map.set(dk, d);
    const link = `${fact}${LINK_SEP}${dk}`;
    for (const ante of d.positive) {
      let s = this.posDependents.get(ante);
      if (!s) {
        s = new Set();
        this.posDependents.set(ante, s);
      }
      s.add(link);
    }
    for (const ante of d.negative) {
      let s = this.negDependents.get(ante);
      if (!s) {
        s = new Set();
        this.negDependents.set(ante, s);
      }
      s.add(link);
    }
  }

  private dropDerivation(fact: string, dk: string): void {
    const map = this.derivations.get(fact);
    const d = map?.get(dk);
    if (!map || !d) return;
    map.delete(dk);
    const link = `${fact}${LINK_SEP}${dk}`;
    for (const ante of d.positive) this.posDependents.get(ante)?.delete(link);
    for (const ante of d.negative) this.negDependents.get(ante)?.delete(link);
  }

  /**
   * Cascade deletions/insertions through the provenance graph.
   * Deleted keys invalidate derivations that use them positively;
   * inserted keys invalidate derivations that rely on their absence.
   */
  private propagate(deleted: string[], inserted: string[]): void {
    const delQueue = [...deleted];
    const insQueue = [...inserted];
    const invalidate = (link: string) => {
      const sep = link.indexOf(LINK_SEP);
      const fact = link.slice(0, sep);
      const dk = link.slice(sep + 1);
      this.dropDerivation(fact, dk);
      if (
        !this.base.has(fact) &&
        (this.derivations.get(fact)?.size ?? 0) === 0 &&
        this.facts.has(fact)
      ) {
        this.removeFromStore(fact);
        delQueue.push(fact);
      }
    };
    while (delQueue.length > 0 || insQueue.length > 0) {
      while (delQueue.length > 0) {
        const k = delQueue.pop()!;
        for (const link of this.posDependents.get(k) ?? []) invalidate(link);
        this.posDependents.delete(k);
      }
      while (insQueue.length > 0) {
        const k = insQueue.pop()!;
        for (const link of this.negDependents.get(k) ?? []) invalidate(link);
        this.negDependents.delete(k);
      }
    }
  }

  // ------------------------------------------------------------------
  // Evaluation
  // ------------------------------------------------------------------

  /**
   * Re-derive to fixpoint, layer by layer. Evaluation only adds facts and
   * derivations; after each layer, derivations in higher layers that relied
   * on the absence of a newly derived fact are invalidated (and cascade).
   */
  private reevaluate(): void {
    for (const stratum of this.compiled.strata) {
      const added = this.evaluateStratum(stratum);
      if (added.length > 0) this.propagate([], added);
    }
  }

  /** Returns the keys of facts newly derived in this stratum. */
  private evaluateStratum(stratum: Stratum): string[] {
    const added: string[] = [];
    const preds = new Set(stratum.preds);
    // Seed the delta with everything already known in this stratum so that
    // derivations of surviving facts are re-recorded after deletions.
    let delta = new Map<string, Set<string>>();
    for (const p of preds) delta.set(p, new Set(this.byPred.get(p) ?? []));

    let first = true;
    while (first || [...delta.values()].some((s) => s.size > 0)) {
      const nextDelta = new Map<string, Set<string>>();
      for (const rule of stratum.rules) {
        const stratumPosIdxs: number[] = [];
        rule.body.forEach((lit, i) => {
          if (!lit.negated && preds.has(lit.atom.pred)) stratumPosIdxs.push(i);
        });
        if (stratumPosIdxs.length === 0) {
          // No recursive literal: one full evaluation suffices.
          if (first) this.evalRule(rule, -1, delta, nextDelta, added);
        } else {
          for (const i of stratumPosIdxs) this.evalRule(rule, i, delta, nextDelta, added);
        }
      }
      first = false;
      delta = nextDelta;
    }
    return added;
  }

  /**
   * Join-evaluate one rule. If `distinguished >= 0`, the positive body
   * literal at that position is matched against `delta` only (semi-naive).
   */
  private evalRule(
    rule: Rule,
    distinguished: number,
    delta: Map<string, Set<string>>,
    nextDelta: Map<string, Set<string>>,
    added: string[]
  ): void {
    const body = rule.body;
    const rec = (pos: number, env: Subst, posAnte: string[], negAnte: string[]): void => {
      if (pos === body.length) {
        this.emit(rule, env, posAnte, negAnte, nextDelta, added);
        return;
      }
      const lit = body[pos]!;
      if (!lit.negated) {
        const source =
          pos === distinguished
            ? delta.get(lit.atom.pred)
            : this.byPred.get(lit.atom.pred);
        if (!source) return;
        for (const key of source) {
          const fact = this.facts.get(key);
          if (!fact) continue;
          const env2 = unifyArgs(lit.atom.args, fact.args, env);
          if (env2) rec(pos + 1, env2, [...posAnte, key], negAnte);
        }
      } else {
        const key = groundKey(lit.atom, env);
        if (key !== null && !this.facts.has(key)) {
          rec(pos + 1, env, posAnte, [...negAnte, key]);
        }
      }
    };
    rec(0, new Map(), [], []);
  }

  private emit(
    rule: Rule,
    env: Subst,
    posAnte: string[],
    negAnte: string[],
    nextDelta: Map<string, Set<string>>,
    added: string[]
  ): void {
    const args: Const[] = [];
    for (const t of rule.head.args) {
      if (isVar(t)) {
        const v = env.get(t.name);
        if (v === undefined) return; // unreachable for safe rules
        args.push(v);
      } else {
        args.push(t.value);
      }
    }
    const key = factKey(rule.head.pred, args);
    const isNew = !this.facts.has(key);
    if (isNew) {
      this.addToStore({ pred: rule.head.pred, args });
      let set = nextDelta.get(rule.head.pred);
      if (!set) {
        set = new Set();
        nextDelta.set(rule.head.pred, set);
      }
      set.add(key);
      added.push(key);
    }
    this.recordDerivation(key, {
      ruleId: rule.id,
      positive: posAnte,
      negative: negAnte,
    });
  }
}

function unifyArgs(terms: readonly Term[], args: readonly Const[], env: Subst): Subst | null {
  if (terms.length !== args.length) return null;
  const out: Subst = new Map(env);
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i]!;
    const a = args[i]!;
    if (isVar(t)) {
      const bound = out.get(t.name);
      if (bound === undefined) out.set(t.name, a);
      else if (bound !== a) return null;
    } else if (t.value !== a) {
      return null;
    }
  }
  return out;
}

/** Ground an atom under the substitution; null if some variable is unbound. */
function groundKey(atom: Atom, env: Subst): string | null {
  const args: Const[] = [];
  for (const t of atom.args) {
    if (isVar(t)) {
      const v = env.get(t.name);
      if (v === undefined) return null;
      args.push(v);
    } else {
      args.push(t.value);
    }
  }
  return factKey(atom.pred, args);
}
