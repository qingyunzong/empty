import { errJson, OeeError } from './errors.js';
import { validateParams, validateEvents, checkClock } from './validate.js';
import { analyze } from './analyze.js';

// Stateful press line. ingest() is atomic: any ERR_* leaves the state unchanged.
export class Line {
  constructor(params = {}) {
    this.params = validateParams(params);
    this.events = [];
  }

  ingest(batch) {
    try {
      const valid = validateEvents(batch);
      const merged = validateEvents([...this.events, ...valid]); // dedup/conflict vs history
      checkClock(merged, this.params); // arrival order: history then new batch
      this.events = merged; // commit only after every check passed
      return { ok: true, accepted: valid.length, total: merged.length };
    } catch (e) {
      if (e instanceof OeeError) return errJson(e);
      throw e;
    }
  }

  analyze() {
    return analyze({ events: this.events, params: this.params });
  }
}
