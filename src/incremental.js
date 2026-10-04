import { Simulation } from './simulator.js';
import { pickFromBuffer } from './core.js';
import { normalizeConfig } from './model.js';
import { SimError, ERR_DOMAIN } from './errors.js';

// Incremental re-simulation. The initial run records a checkpoint at every
// timestamp containing a policy-sensitive decision (a dequeue from a buffer
// holding >= 2 items). When the policy changes, only the suffix from the
// first decision whose outcome would differ is recomputed; everything before
// it is reused verbatim.
export class IncrementalSimulation {
  constructor(config) {
    this.norm = normalizeConfig(config);
    this.checkpoints = [];
    this.sim = new Simulation(this.norm, { recordCheckpoints: true, checkpoints: this.checkpoints });
    this.result = null;
  }

  run() {
    this.result = this.sim.run();
    return this.result;
  }

  setPolicy(policy) {
    if (policy !== 'fifo' && policy !== 'priority') {
      throw new SimError(ERR_DOMAIN, `unknown policy: ${policy}`);
    }
    if (!this.result) this.run();
    if (policy === this.sim.policy) {
      return {
        result: this.result,
        stats: { divergenceTime: null, reusedEvents: this.sim.trace.length, recomputedEvents: 0, totalEvents: this.sim.trace.length },
      };
    }
    for (let k = 0; k < this.checkpoints.length; k += 1) {
      const cp = this.checkpoints[k];
      const diverges = cp.decisions.some((d) => pickFromBuffer(d.items, policy).id !== d.chosen);
      if (!diverges) continue;
      this.checkpoints.length = k;
      this.sim.restore(cp.snapshot);
      this.sim.setPolicy(policy);
      this.result = this.sim.run();
      const total = this.sim.trace.length;
      return {
        result: this.result,
        stats: { divergenceTime: cp.time, reusedEvents: cp.traceLength, recomputedEvents: total - cp.traceLength, totalEvents: total },
      };
    }
    this.sim.setPolicy(policy);
    return {
      result: this.result,
      stats: { divergenceTime: null, reusedEvents: this.sim.trace.length, recomputedEvents: 0, totalEvents: this.sim.trace.length },
    };
  }
}
