// Independent certificate verification: re-derives everything from the raw
// event log and the certificate's event ids, trusting nothing else.

import { checkRateConsistency } from './rates.js';
import { toString as ratToString } from './rational.js';

export function verifyCertificate(log, cert) {
  const rates = log.rates();
  const byEid = new Map(rates.map((r) => [r.eid, r]));

  const missing = (cert.events ?? []).filter((eid) => !byEid.has(eid));
  const eventsResolved = Array.isArray(cert.events) && cert.events.length > 0 && missing.length === 0;

  let inconsistent = false;
  let minimal = false;
  let payloadsMatch = false;

  if (eventsResolved) {
    const subset = cert.events.map((eid) => byEid.get(eid));
    inconsistent = !checkRateConsistency(subset).ok;
    minimal = subset.every((_, i) =>
      checkRateConsistency(subset.filter((__, j) => j !== i)).ok
    );
    // Anti-tamper: every rate quoted inside the certificate must match the log.
    payloadsMatch =
      Array.isArray(cert.cycle) &&
      cert.cycle.every((c) => {
        const r = byEid.get(c.eid);
        return r && r.pair === c.pair && ratToString(r.rate) === c.rate;
      });
  }

  const checks = { eventsResolved, payloadsMatch, inconsistent, minimal };
  return {
    valid: eventsResolved && payloadsMatch && inconsistent && minimal,
    checks,
    ...(missing.length ? { missing } : {}),
    events: cert.events ?? [],
  };
}
