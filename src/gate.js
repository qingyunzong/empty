import { evaluate, toBool, GateError } from './expr.js';
import { WindowAgg } from './windows.js';

export class Engine {
  constructor(store) {
    this.store = store;
    this.rules = store.rules;
    this.windows = new WindowAgg(
      this.rules.windows,
      () => Object.values(this.store.state.observations),
      (obs) => this.envFor(obs),
      this.store.state.caches,
    );
  }

  envFor(obs) {
    const env = { key: obs.key, ts: obs.ts, ...obs.metrics };
    for (const d of this.rules.derived) {
      env[d.name] = evaluate(d.ast, env, null);
    }
    return env;
  }

  decide(key) {
    const obs = this.store.state.observations[key];
    if (!obs) throw new GateError('E_INPUT', `unknown observation key '${key}'`);
    const env = this.envFor(obs);
    const windowKeys = new Set();
    const agg = (node) => {
      const { value, windowKey } = this.windows.aggregate(node.win, node, obs.ts);
      windowKeys.add(windowKey);
      return value;
    };
    const evaluations = [];
    const exemptionChain = [];
    const violations = [];
    const undecided = [];
    for (const rule of this.rules.rules) {
      const result = toBool(evaluate(rule.ast, env, agg));
      const ev = { ruleId: rule.id, astHash: rule.hash, result };
      if (result === false) {
        const winner = this.matchExemptions(rule, env, obs);
        if (winner) {
          ev.exempted = true;
          ev.exemption = { id: winner.exemption.id, priority: winner.exemption.priority };
          exemptionChain.push({
            ruleId: rule.id,
            outcome: 'applied',
            id: winner.exemption.id,
            priority: winner.exemption.priority,
            contenders: winner.contenders,
          });
        } else {
          violations.push(rule.id);
        }
      } else if (result === null) {
        undecided.push(rule.id);
      }
      evaluations.push(ev);
    }
    const decision = violations.length > 0 ? 'fail' : undecided.length > 0 ? 'undecided' : 'pass';
    return {
      version: 1,
      key,
      ts: obs.ts,
      decision,
      rulesHash: this.rules.rulesHash,
      seq: this.store.state.seq,
      evaluations,
      violations,
      undecided,
      exemptionChain,
      windowKeys: [...windowKeys].sort(),
    };
  }

  matchExemptions(rule, env, obs) {
    const matches = [];
    for (const e of this.rules.exemptions) {
      if (!e.rules.includes('*') && !e.rules.includes(rule.id)) continue;
      if (e.from !== null && obs.ts < e.from) continue;
      if (e.until !== null && obs.ts > e.until) continue;
      if (e.when !== null && toBool(evaluate(e.when, env, null)) !== true) continue;
      matches.push(e);
    }
    if (matches.length === 0) return null;
    const top = Math.max(...matches.map((m) => m.priority));
    const winners = matches.filter((m) => m.priority === top);
    if (winners.length > 1) {
      throw new GateError(
        'E_EXEMPT',
        `exemption conflict for rule '${rule.id}': ${winners.map((w) => w.id).join(', ')} tie at priority ${top}`,
      );
    }
    return { exemption: winners[0], contenders: matches.map((m) => m.id) };
  }
}
