import { validateEvent } from './schema.js';
import { clockError, conflictError } from './errors.js';
import { resolveParams } from './params.js';
import { analyze } from './analyze.js';

// Ordered ingestion with clock-rollback protection. Out-of-order delivery
// within maxSkewMs is tolerated; a rollback beyond it raises ERR_CLOCK and
// leaves the ingested state untouched.
export class Ingestor {
  constructor(paramOverrides = {}) {
    this.params = resolveParams(paramOverrides);
    this.events = [];
    this.byId = new Map();
    this.maxStartSeen = null;
  }

  ingest(raw) {
    const event = validateEvent(raw, this.events.length);
    if (this.maxStartSeen !== null && event.start < this.maxStartSeen - this.params.maxSkewMs) {
      throw clockError('clock rollback exceeds maxSkewMs; event rejected, state unchanged', {
        eventStart: event.start,
        maxStartSeen: this.maxStartSeen,
        rollbackMs: this.maxStartSeen - event.start,
        maxSkewMs: this.params.maxSkewMs,
      });
    }
    const prev = this.byId.get(event.id);
    if (prev) {
      const identical = prev.type === event.type && prev.start === event.start && prev.end === event.end;
      if (identical) return this.snapshot(); // exact re-delivery: no-op
      throw conflictError(`duplicate event id "${event.id}" with conflicting payload`, {
        first: prev,
        second: event,
      });
    }
    this.events.push(event);
    this.byId.set(event.id, event);
    this.maxStartSeen = this.maxStartSeen === null ? event.start : Math.max(this.maxStartSeen, event.start);
    return this.snapshot();
  }

  ingestAll(rawEvents) {
    return rawEvents.map((raw) => this.ingest(raw));
  }

  snapshot() {
    return { accepted: this.events.length, maxStartSeen: this.maxStartSeen };
  }

  analyze(options = {}) {
    return analyze(this.events, this.params, options);
  }
}
