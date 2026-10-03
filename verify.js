'use strict';

const fs = require('node:fs');
const { merkleRoot } = require('./lib/merkle');
const { canonicalOrder, depsOf } = require('./lib/collector');
const { eventChecksum } = require('./lib/frame');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node verify.js <cert.json>');
  process.exit(64);
}

let cert;
try {
  cert = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  fail(`cannot read certificate: ${err.message}`);
}

if (!Array.isArray(cert.events)) fail('certificate has no events array');
if (cert.eventCount !== cert.events.length) fail(`eventCount ${cert.eventCount} != ${cert.events.length} events`);

// 1. Event integrity: checksums and canonical causal order.
for (const ev of cert.events) {
  if (ev.checksum !== eventChecksum(ev)) fail(`bad checksum on event ${ev.eventId}`);
}
const want = canonicalOrder(cert.events);
const got = cert.events.map((e) => e.eventId);
if (JSON.stringify(want) !== JSON.stringify(got)) fail('events are not in canonical causal order');

// 2. Effective amounts: reversal negates its target; links inside the period
//    are re-derived, external links (frozen earlier periods) use the recorded value.
const eff = new Map();
for (const ev of cert.events) {
  let e;
  if (ev.reversalOf) {
    const ref = eff.get(ev.reversalOf);
    if (ref !== undefined) {
      e = -ref;
      if (e !== ev.effective) fail(`event ${ev.eventId}: effective ${ev.effective} != -(${ref}) of ${ev.reversalOf}`);
    } else {
      e = ev.effective;
    }
  } else {
    e = ev.amount;
    if (e !== ev.effective) fail(`event ${ev.eventId}: effective ${ev.effective} != amount ${ev.amount}`);
  }
  if (typeof e !== 'number' || !Number.isSafeInteger(e)) fail(`event ${ev.eventId}: bad effective amount`);
  eff.set(ev.eventId, e);
  for (const d of depsOf(ev)) {
    if (!cert.events.some((x) => x.eventId === d) && ev.effective === undefined) {
      fail(`event ${ev.eventId}: unresolved external link ${d}`);
    }
  }
}

// 3. Merkle root over the canonical event list.
const root = merkleRoot(cert.events);
if (root !== cert.merkleRoot) fail(`merkleRoot mismatch: recomputed ${root}`);

// 4. Balances: prevBalances + this period's deltas == frozen balances.
const delta = {};
for (const ev of cert.events) delta[ev.acct] = (delta[ev.acct] || 0) + eff.get(ev.eventId);
for (const [acct, bal] of Object.entries(cert.balances)) {
  const prev = (cert.prevBalances && cert.prevBalances[acct]) || 0;
  if (prev + (delta[acct] || 0) !== bal) {
    fail(`balance mismatch for ${acct}: ${prev} + ${delta[acct] || 0} != ${bal}`);
  }
}
for (const acct of Object.keys(cert.prevBalances || {})) {
  if (!(acct in cert.balances)) fail(`acct ${acct} present in prevBalances but missing in balances`);
}

console.log(`OK period=${cert.period} events=${cert.eventCount} merkleRoot=${cert.merkleRoot}`);
