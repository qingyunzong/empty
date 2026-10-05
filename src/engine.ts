/**
 * Stratified Datalog engine with provenance-tracked incremental maintenance.
 *
 * - Evaluation is bottom-up, stratum by stratum (semi-naive within a
 *   stratum), producing the minimal model of the program.
 * - Every derived fact records all of its derivations (rule instantiation +
 *   positive support facts + negative support atoms).
 * - Fact insertion/retraction is incremental: deletions cascade through the
 *   provenance graph (DRed-style delete phase), then only the affected
 *   strata are re-derived, so stale negation-based conclusions are removed
 *   and newly unblocked ones are re-established.
 * - `recompute()` rebuilds the model from scratch and acts as the oracle
 *   that tests compare incremental results (and provenance) against.
 */

import { compile, CompileError, CompiledProgram } from "./compile.js";
import {
  Atom,
  Const,
  Derivation,
  Rule,
  Substitution,
  Term,
  atomKey,
  derivationKey,
  predOfKey,
} from "./core.js";
import { parseFact, parseRules } from "./parser.js";

export { CompileError };

interface Match {
  readonly subst: Substitution;
  readonly pos: string[];
  readonly neg: string[];
}

export interface Snapshot {
  readonly model: readonly string[];
  readonly provenance: Readonly<Record<string, readonly string[]>>;
}

export class Engine {
  private rules: Rule[] = [];
  private compiled: CompiledProgram = compile([]);

  /** Ground EDB facts: key -> args. */
  private readonly edb = new Map<string, Const[]>();
  /** Arity of EDB-only predicates (those not mentioned in any rule). */
  private readonly edbArity = new Map<string, number>();
  /** Facts with at least one live derivation: key -> args. */
  private readonly derived = new Map<string, Const[]>();
  /** Arguments of every currently-true fact (EDB or derived). */
  private readonly factArgs = new Map<string, Const[]>();
  private readonly edbIndex = new Map<string, Set<string>>();
  private readonly idbIndex = new Map<string, Set<string>>();

  private readonly derivations = new Map<string, Derivation>();
  private readonly derivationsOf = new Map<string, Set<string>>();
  private readonly posConsumers = new Map<string, Set<string>>();
  private readonly negConsumers = new Map<string, Set<string>>();

  // ---------------------------------------------------------------- schema

  /** Parse and add rules. Changing the rule set triggers a full recompute. */
  addRules(source: string): void {
    const parsed = parseRules(source);
    const arity = new Map(this.compiled.predArity);
    for (const rule of parsed) {
      const check = (pred: string, n: number) => {
        const prev = arity.get(pred);
        if (prev !== undefined && prev !== n)
          throw new CompileError(
            `predicate '${pred}' used with arity ${n} but arity ${prev} elsewhere`,
          );
        arity.set(pred, n);
      };
      check(rule.head.pred, rule.head.args.length);
      for (const lit of rule.body) check(lit.atom.pred, lit.atom.args.length);
    }
    this.rules = [...this.rules, ...parsed];
    this.compiled = compile(this.rules);
    this.recompute();
  }

  get program(): CompiledProgram {
    return this.compiled;
  }

  // ------------------------------------------------------------------ EDB

  /** Insert a ground fact incrementally. Returns false if already present. */
  addFact(pred: string, ...args: Const[]): boolean {
    this.checkArity(pred, args);
    const key = atomKey(pred, args);
    if (this.edb.has(key)) return false;
    this.edb.set(key, args);
    this.addToIndex(this.edbIndex, pred, key);
    this.factArgs.set(key, args);

    const dirty = new Set<number>();
    // The new fact falsifies `not pred(...)` in higher strata: kill those
    // derivations first, then re-derive everything the fact enables.
    this.invalidateNegativeConsumers(key, dirty);
    this.addAll(dirty, this.compiled.consumerStrata.get(pred));
    this.repair(dirty);
    return true;
  }

  /** Retract a ground EDB fact incrementally. Returns false if absent. */
  retractFact(pred: string, ...args: Const[]): boolean {
    const key = atomKey(pred, args);
    const known = this.edb.get(key);
    if (known === undefined) return false;
    this.edb.delete(key);
    this.removeFromIndex(this.edbIndex, pred, key);
    if (!this.derived.has(key)) this.factArgs.delete(key);

    const dirty = new Set<number>();
    if (!this.derived.has(key)) {
      // The fact is fully gone: derivations using it positively must die.
      const consumers = this.posConsumers.get(key);
      if (consumers) this.cascadeDeletions([...consumers], dirty);
    }
    // Its absence may now satisfy `not pred(...)` in consuming strata.
    this.addAll(dirty, this.compiled.consumerStrata.get(pred));
    this.repair(dirty);
    return true;
  }

  // ------------------------------------------------------------- queries

  /** All currently-true ground facts of a predicate, as argument tuples. */
  query(pred: string): Const[][] {
    const keys = new Set<string>();
    for (const key of this.edbIndex.get(pred) ?? []) keys.add(key);
    for (const key of this.idbIndex.get(pred) ?? []) keys.add(key);
    return [...keys]
      .map((key) => this.factArgs.get(key)!)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  /** Sorted keys of every true fact (EDB + derived). */
  model(): string[] {
    return [...this.factArgs.keys()].sort();
  }

  /** Live derivations of a ground fact, empty if the fact is not derivable. */
  why(pred: string, ...args: Const[]): Derivation[] {
    const key = atomKey(pred, args);
    const keys = this.derivationsOf.get(key);
    if (!keys) return [];
    return [...keys].map((k) => this.derivations.get(k)!);
  }

  /** Model + provenance, for differential comparison against recompute(). */
  snapshot(): Snapshot {
    const provenance: Record<string, readonly string[]> = {};
    for (const [fact, keys] of this.derivationsOf) {
      if (keys.size > 0) provenance[fact] = [...keys].sort();
    }
    return { model: this.model(), provenance };
  }

  // -------------------------------------------------------------- oracle

  /** Discard all derived state and re-evaluate every stratum from scratch. */
  recompute(): void {
    this.derived.clear();
    this.idbIndex.clear();
    this.derivations.clear();
    this.derivationsOf.clear();
    this.posConsumers.clear();
    this.negConsumers.clear();
    this.factArgs.clear();
    for (const [key, args] of this.edb) {
      this.factArgs.set(key, args);
    }
    for (let s = 1; s < this.compiled.strata.length; s++) this.evalStratum(s);
  }

  // ---------------------------------------------------------- evaluation

  /**
   * Semi-naive fixpoint evaluation of one stratum. Lower strata are already
   * fully evaluated, so only same-stratum predicates participate in deltas.
   * Returns the keys of facts that became true during this call.
   */
  private evalStratum(stratum: number): string[] {
    const rules = this.compiled.strata[stratum];
    if (!rules || rules.length === 0) return [];
    const localPreds = new Set(rules.map((r) => r.head.pred));
    const allNew: string[] = [];
    let delta: Map<string, Set<string>> | null = null;
    for (;;) {
      const roundNew: string[] = [];
      for (const rule of rules) {
        if (delta === null) {
          this.evalRule(rule, null, roundNew);
        } else {
          rule.posBody.forEach((lit, i) => {
            if (!localPreds.has(lit.atom.pred)) return;
            const only = delta!.get(lit.atom.pred);
            if (only && only.size > 0) this.evalRule(rule, { idx: i, only }, roundNew);
          });
        }
      }
      if (roundNew.length === 0) break;
      delta = new Map();
      for (const key of roundNew) {
        const pred = predOfKey(key);
        let set = delta.get(pred);
        if (!set) delta.set(pred, (set = new Set()));
        set.add(key);
      }
      allNew.push(...roundNew);
    }
    return allNew;
  }

  private evalRule(
    rule: Rule,
    restrict: { idx: number; only: Set<string> } | null,
    roundNew: string[],
  ): void {
    for (const m of this.matchRule(rule, restrict)) {
      const headArgs = rule.head.args.map((t) =>
        t.kind === "const" ? t.value : m.subst.get(t.name)!,
      );
      const headKey = atomKey(rule.head.pred, headArgs);
      const dkey = derivationKey(rule.id, headKey, m.pos, m.neg);
      if (this.derivations.has(dkey)) continue;
      const isNewFact = !this.factArgs.has(headKey);
      this.recordDerivation(
        {
          key: dkey,
          ruleId: rule.id,
          ruleText: rule.text,
          head: headKey,
          pos: m.pos,
          neg: m.neg,
        },
        headArgs,
      );
      if (isNewFact) roundNew.push(headKey);
    }
  }

  /** Nested-loop join: positive literals first, then negative checks. */
  private *matchRule(
    rule: Rule,
    restrict: { idx: number; only: Set<string> } | null,
  ): Generator<Match> {
    const pos = rule.posBody;
    const neg = rule.negBody;
    const self = this;

    function* rec(i: number, subst: Substitution, posKeys: string[]): Generator<Match> {
      if (i === pos.length) {
        const negKeys: string[] = [];
        for (const lit of neg) {
          const key = groundKey(lit.atom, subst);
          if (self.factArgs.has(key)) return;
          negKeys.push(key);
        }
        yield { subst, pos: posKeys, neg: negKeys };
        return;
      }
      const lit = pos[i]!;
      const candidates =
        restrict && restrict.idx === i ? restrict.only : self.keysOf(lit.atom.pred);
      for (const factKey of candidates) {
        const bound = unify(lit.atom.args, self.factArgs.get(factKey)!, subst);
        if (bound) yield* rec(i + 1, bound, [...posKeys, factKey]);
      }
    }

    yield* rec(0, new Map(), []);
  }

  private *keysOf(pred: string): Generator<string> {
    yield* this.edbIndex.get(pred) ?? [];
    yield* this.idbIndex.get(pred) ?? [];
  }

  private recordDerivation(d: Derivation, headArgs: Const[]): void {
    this.derivations.set(d.key, d);
    let ofFact = this.derivationsOf.get(d.head);
    if (!ofFact) this.derivationsOf.set(d.head, (ofFact = new Set()));
    ofFact.add(d.key);
    for (const p of d.pos) {
      let set = this.posConsumers.get(p);
      if (!set) this.posConsumers.set(p, (set = new Set()));
      set.add(d.key);
    }
    for (const n of d.neg) {
      let set = this.negConsumers.get(n);
      if (!set) this.negConsumers.set(n, (set = new Set()));
      set.add(d.key);
    }
    if (!this.derived.has(d.head)) {
      this.derived.set(d.head, headArgs);
      this.factArgs.set(d.head, headArgs);
      this.addToIndex(this.idbIndex, predOfKey(d.head), d.head);
    }
  }

  // -------------------------------------------------- incremental update

  /**
   * DRed delete phase: kill the seed derivations, then recursively kill
   * everything they support. Facts are over-deleted: a fact whose
   * derivations are touched is removed together with ALL of its
   * derivations, and the repair phase re-derives whatever still has valid
   * support. Counting remaining derivations instead would be unsound —
   * circular derivations (e.g. `p(X) :- p(X).`) would keep each other
   * alive with no factual basis. Records affected strata in `dirty`.
   */
  private cascadeDeletions(seedDerivationKeys: string[], dirty: Set<number>): void {
    const derivQueue = [...seedDerivationKeys];
    const factQueue: string[] = [];
    while (derivQueue.length > 0 || factQueue.length > 0) {
      while (derivQueue.length > 0) {
        const dkey = derivQueue.pop()!;
        const d = this.derivations.get(dkey);
        if (!d) continue;
        if (this.edb.has(d.head)) {
          // The head stays true via the EDB; only the derivation dies.
          this.removeDerivation(d);
        } else {
          factQueue.push(d.head);
        }
      }
      while (factQueue.length > 0) {
        const fact = factQueue.pop()!;
        if (!this.derived.has(fact)) continue;
        for (const dk of this.derivationsOf.get(fact) ?? []) {
          const d = this.derivations.get(dk);
          if (d) this.removeDerivation(d);
        }
        this.derived.delete(fact);
        this.factArgs.delete(fact);
        this.removeFromIndex(this.idbIndex, predOfKey(fact), fact);
        const pred = predOfKey(fact);
        dirty.add(this.compiled.predStratum.get(pred)!);
        this.addAll(dirty, this.compiled.consumerStrata.get(pred));
        const consumers = this.posConsumers.get(fact);
        if (consumers) derivQueue.push(...consumers);
        // Negative consumers of `fact` are not deleted — its absence may
        // satisfy them; the repair phase re-derives those strata.
      }
    }
  }

  private removeDerivation(d: Derivation): void {
    this.derivations.delete(d.key);
    this.derivationsOf.get(d.head)?.delete(d.key);
    for (const p of d.pos) this.posConsumers.get(p)?.delete(d.key);
    for (const n of d.neg) this.negConsumers.get(n)?.delete(d.key);
  }

  /** A fact becoming true kills derivations that assumed its absence. */
  private invalidateNegativeConsumers(factKey: string, dirty: Set<number>): void {
    const consumers = this.negConsumers.get(factKey);
    if (consumers && consumers.size > 0) this.cascadeDeletions([...consumers], dirty);
  }

  /**
   * Re-derive affected strata in ascending order. Newly derived facts kill
   * negative consumers in strictly higher strata, so a single ascending
   * pass with a dirty-set worklist is complete.
   */
  private repair(dirty: Set<number>): void {
    while (dirty.size > 0) {
      const s = Math.min(...dirty);
      dirty.delete(s);
      if (s <= 0 || s >= this.compiled.strata.length) continue;
      const newFacts = this.evalStratum(s);
      for (const fact of newFacts) {
        this.invalidateNegativeConsumers(fact, dirty);
        this.addAll(dirty, this.compiled.consumerStrata.get(predOfKey(fact)));
      }
    }
  }

  // -------------------------------------------------------------- helpers

  private checkArity(pred: string, args: readonly Const[]): void {
    const expected = this.compiled.predArity.get(pred);
    if (expected !== undefined && expected !== args.length)
      throw new CompileError(
        `predicate '${pred}' expects arity ${expected}, got ${args.length}`,
      );
    const seen = this.edbArity.get(pred);
    if (seen === undefined) this.edbArity.set(pred, args.length);
    else if (seen !== args.length)
      throw new CompileError(
        `predicate '${pred}' expects arity ${seen}, got ${args.length}`,
      );
  }

  private addToIndex(index: Map<string, Set<string>>, pred: string, key: string): void {
    let set = index.get(pred);
    if (!set) index.set(pred, (set = new Set()));
    set.add(key);
  }

  private removeFromIndex(
    index: Map<string, Set<string>>,
    pred: string,
    key: string,
  ): void {
    index.get(pred)?.delete(key);
  }

  private addAll(target: Set<number>, source: Iterable<number> | undefined): void {
    if (source) for (const s of source) target.add(s);
  }
}

function groundKey(atom: Atom, subst: Substitution): string {
  const args = atom.args.map((t) =>
    t.kind === "const" ? t.value : subst.get(t.name)!,
  );
  return atomKey(atom.pred, args);
}

function unify(
  terms: readonly Term[],
  args: readonly Const[],
  subst: Substitution,
): Substitution | null {
  const out: Substitution = new Map(subst);
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i]!;
    if (t.kind === "const") {
      if (t.value !== args[i]) return null;
    } else {
      const bound = out.get(t.name);
      if (bound === undefined) out.set(t.name, args[i]!);
      else if (bound !== args[i]) return null;
    }
  }
  return out;
}

/** Convenience: build an engine from rule text plus fact text lines. */
export function loadProgram(rules: string, facts: string[] = []): Engine {
  const engine = new Engine();
  engine.addRules(rules);
  for (const f of facts) {
    const { pred, args } = parseFact(f);
    engine.addFact(pred, ...args);
  }
  return engine;
}
