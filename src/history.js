'use strict';

const { conflictDomain } = require('./errors');

// Conflict domain: same account + same day. Repairs inside one domain must be
// linearizable by (lamport, source, seq). An event arriving for a domain whose
// key orders before the domain's last applied event is rejected.
function domainKeyOf(event) {
  return `${event.accountId}|${event.day}`;
}

function orderKeyOf(event) {
  return [event.lamport, event.source, event.seq];
}

function compareOrder(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.seq - b.seq;
}

class History {
  constructor() {
    this.domains = new Map(); // domainKey -> last applied event
    this.events = [];         // linearized applied events
  }

  // Validate and record an event in its conflict domain.
  admit(event) {
    for (const f of ['accountId', 'day', 'source']) {
      if (typeof event[f] !== 'string' || event[f].length === 0) {
        throw conflictDomain(`event missing ${f}`, { event });
      }
    }
    if (!Number.isInteger(event.lamport) || event.lamport < 0) {
      throw conflictDomain('event has bad lamport clock', { event });
    }
    if (!Number.isInteger(event.seq) || event.seq < 0) {
      throw conflictDomain('event has bad source seq', { event });
    }
    const key = domainKeyOf(event);
    const last = this.domains.get(key);
    if (last && compareOrder(event, last) <= 0) {
      throw conflictDomain(
        `event orders at-or-before last applied event in domain ${key}`,
        { domain: key, last: orderKeyOf(last), incoming: orderKeyOf(event) },
      );
    }
    this.domains.set(key, event);
    this.events.push(event);
    return event;
  }

  // Global linearized view: sort applied events by (lamport, source, seq).
  linearized() {
    return [...this.events].sort(compareOrder);
  }

  lastInDomain(accountId, day) {
    return this.domains.get(`${accountId}|${day}`) || null;
  }
}

class LamportClock {
  constructor() { this.time = 0; }
  tick() { this.time += 1; return this.time; }
  observe(other) { this.time = Math.max(this.time, other) + 1; return this.time; }
}

module.exports = { History, LamportClock, domainKeyOf, compareOrder };
