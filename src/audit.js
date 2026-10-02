'use strict';

const crypto = require('crypto');

// Canonical serialization: object keys sorted recursively, no whitespace.
// Same logical value always serializes to the same string, so the hash
// chain is independently verifiable.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

const GENESIS = '0'.repeat(64);

// Hash chain: head_0 = 64 zeros; head_i = sha256hex(head_{i-1} + '|' + canonical(event_i)).
class AuditChain {
  constructor() {
    this.head = GENESIS;
    this.events = [];
  }

  record(type, data) {
    const event = { seq: this.events.length, type, data };
    this.head = sha256hex(this.head + '|' + canonical(event));
    this.events.push(event);
    return event;
  }

  // Independent recomputation from the event log.
  static verify(events) {
    let head = GENESIS;
    events.forEach((event, i) => {
      if (event.seq !== i) return null;
      head = sha256hex(head + '|' + canonical(event));
    });
    return head;
  }

  verify() {
    return AuditChain.verify(this.events) === this.head;
  }
}

module.exports = { AuditChain, canonical, sha256hex, GENESIS };
