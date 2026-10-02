import { ExitError, EXIT, refOf } from './model.js';

const SPECIFICITY = { factory: 1, workshop: 2, reactor: 3 };

// Pure permission resolution: most specific active rule covering the reactor
// wins; ties broken by latest ts. A deny truncates inherited grants.
export function resolvePermission(model, rules, reactor, recipe, version) {
  const workshop = model.reactorToWorkshop.get(reactor);
  let best = null;
  for (const rule of rules) {
    if (!rule.active || rule.recipe !== recipe || rule.version !== version) continue;
    let spec = 0;
    if (rule.level === 'factory') spec = SPECIFICITY.factory;
    else if (rule.level === 'workshop' && rule.workshop === workshop) spec = SPECIFICITY.workshop;
    else if (rule.level === 'reactor' && rule.reactor === reactor) spec = SPECIFICITY.reactor;
    if (spec === 0) continue;
    if (!best || spec > best.spec || (spec === best.spec && rule.ts > best.rule.ts)) {
      best = { spec, rule };
    }
  }
  if (!best) return { permitted: false, rule: null };
  return { permitted: best.rule.op === 'grant', rule: best.rule };
}

export class Interpreter {
  constructor(model) {
    this.model = model;
    this.rules = new Map();       // id -> rule record {active, parent}
    this.contents = new Map();    // reactor -> Set of "recipe@version"
    this.decisions = [];          // one entry per feed attempt
    this.deviations = [];         // deviation records from revocations
    this.reactorLog = new Map();  // reactor -> replay entries (feed/empty)
    this.feedsByRule = new Map(); // rule id -> feeds that relied on it
  }

  run(events) {
    for (const ev of events) this.apply(ev);
    return this;
  }

  apply(ev) {
    switch (ev.op) {
      case 'grant': this.#grant(ev); break;
      case 'deny': this.#deny(ev); break;
      case 'revoke': this.#revoke(ev); break;
      case 'feed': this.#feed(ev); break;
      case 'empty': this.#empty(ev); break;
      default: throw new ExitError(1, `unknown op ${JSON.stringify(ev.op)}`);
    }
  }

  activeRules() {
    return [...this.rules.values()].filter((r) => r.active);
  }

  permission(reactor, recipe, version) {
    return resolvePermission(this.model, this.activeRules(), reactor, recipe, version);
  }

  #latestActiveGrant(level, { recipe, version, workshop }) {
    let found = null;
    for (const r of this.rules.values()) {
      if (!r.active || r.op !== 'grant' || r.level !== level) continue;
      if (r.recipe !== recipe || r.version !== version) continue;
      if (level === 'workshop' && r.workshop !== workshop) continue;
      if (!found || r.ts > found.ts) found = r;
    }
    return found;
  }

  #checkScope(ev) {
    if (ev.level === 'workshop' && !this.model.workshops.has(ev.workshop)) {
      throw new ExitError(1, `unknown workshop ${ev.workshop}`);
    }
    if (ev.level === 'reactor' && !this.model.reactorToWorkshop.has(ev.reactor)) {
      throw new ExitError(1, `unknown reactor ${ev.reactor}`);
    }
  }

  #grant(ev) {
    const { id, level, recipe, version } = ev;
    if (this.rules.has(id)) throw new ExitError(EXIT.CHAIN, `duplicate approval id ${id}`);
    let parentId = null;
    if (level === 'factory') {
      // chain root
    } else if (level === 'workshop') {
      const parent = this.#latestActiveGrant('factory', { recipe, version });
      if (!parent) throw new ExitError(EXIT.CHAIN, `workshop grant ${id} has no active factory parent (approval chain broken)`);
      parentId = parent.id;
    } else if (level === 'reactor') {
      const workshop = this.model.reactorToWorkshop.get(ev.reactor);
      if (!workshop) throw new ExitError(1, `unknown reactor ${ev.reactor}`);
      const parent = this.#latestActiveGrant('workshop', { recipe, version, workshop });
      if (!parent) throw new ExitError(EXIT.CHAIN, `reactor grant ${id} has no active workshop parent (approval chain broken)`);
      parentId = parent.id;
    } else {
      throw new ExitError(1, `unknown grant level ${level}`);
    }
    this.#checkScope(ev);
    this.rules.set(id, { ...ev, active: true, parent: parentId });
  }

  #deny(ev) {
    const { id, level } = ev;
    if (this.rules.has(id)) throw new ExitError(EXIT.CHAIN, `duplicate approval id ${id}`);
    if (!(level in SPECIFICITY)) throw new ExitError(1, `unknown deny level ${level}`);
    this.#checkScope(ev);
    this.rules.set(id, { ...ev, active: true, parent: null });
  }

  #revoke(ev) {
    const target = this.rules.get(ev.target);
    if (!target || !target.active) {
      throw new ExitError(EXIT.CHAIN, `revoke targets unknown or inactive approval ${ev.target} (approval chain broken)`);
    }
    const deactivated = [];
    const stack = [target];
    while (stack.length) {
      const rule = stack.pop();
      if (!rule.active) continue;
      rule.active = false;
      deactivated.push(rule);
      for (const child of this.rules.values()) {
        if (child.parent === rule.id && child.active) stack.push(child);
      }
    }
    // History is never erased: feeds already executed under a revoked rule
    // produce deviation records instead.
    for (const rule of deactivated) {
      const feeds = this.feedsByRule.get(rule.id) ?? [];
      if (feeds.length) {
        this.deviations.push({
          type: 'deviation',
          ts: ev.ts,
          approval: rule.id,
          reason: ev.reason ?? null,
          feeds,
        });
      }
    }
  }

  #chainOf(rule) {
    const chain = [rule];
    let cur = rule;
    while (cur.parent) {
      cur = this.rules.get(cur.parent);
      chain.unshift(cur);
    }
    return chain;
  }

  #feed(ev) {
    const { reactor, recipe, version } = ev;
    if (!this.model.reactorToWorkshop.has(reactor)) throw new ExitError(1, `unknown reactor ${reactor}`);
    const rec = this.model.recipes.get(recipe);
    if (rec && rec.versions.has(version) && version < rec.max) {
      throw new ExitError(EXIT.ROLLBACK, `version rollback: ${refOf(recipe, version)} is below current ${recipe}@${rec.max}`);
    }
    const contents = this.contents.get(reactor) ?? new Set();
    const contentsBefore = [...contents].sort();
    const ref = refOf(recipe, version);
    let outcome;
    if (!rec || !rec.versions.has(version)) {
      outcome = { decision: 'deny', reason: 'unknown-recipe' };
    } else {
      const perm = this.permission(reactor, recipe, version);
      if (!perm.permitted) {
        outcome = { decision: 'deny', reason: perm.rule ? 'denied' : 'no-approval', rule: perm.rule ? perm.rule.id : null };
      } else {
        // Forbidden-combination constraint wins over release permission.
        const conflicts = [...contents]
          .filter((c) => (this.model.forbidden.get(c) ?? new Set()).has(ref))
          .sort();
        if (conflicts.length) {
          outcome = { decision: 'deny', reason: 'forbidden', approval: perm.rule.id, conflicts };
        } else {
          const chain = this.#chainOf(perm.rule).map((r) => r.id);
          outcome = { decision: 'allow', approval: perm.rule.id, chain };
        }
      }
    }
    const seq = this.decisions.length;
    if (outcome.decision === 'allow') {
      contents.add(ref);
      this.contents.set(reactor, contents);
      for (const id of outcome.chain) {
        if (!this.feedsByRule.has(id)) this.feedsByRule.set(id, []);
        this.feedsByRule.get(id).push({ seq, ts: ev.ts, reactor, recipe, version });
      }
    }
    this.decisions.push({ seq, ts: ev.ts, reactor, recipe, version, ...outcome });
    this.#log(reactor, {
      seq,
      ts: ev.ts,
      op: 'feed',
      recipe,
      version,
      contentsBefore,
      ...outcome,
      contentsAfter: [...(this.contents.get(reactor) ?? contents)].sort(),
    });
  }

  #empty(ev) {
    const { reactor } = ev;
    if (!this.model.reactorToWorkshop.has(reactor)) throw new ExitError(1, `unknown reactor ${reactor}`);
    const before = [...(this.contents.get(reactor) ?? [])].sort();
    this.contents.set(reactor, new Set());
    this.#log(reactor, { ts: ev.ts, op: 'empty', contentsBefore: before, contentsAfter: [] });
  }

  #log(reactor, entry) {
    if (!this.reactorLog.has(reactor)) this.reactorLog.set(reactor, []);
    this.reactorLog.get(reactor).push(entry);
  }
}
