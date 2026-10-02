// Brute-force reference implementation: full-table scan, no indexes.
// Used to cross-check the indexed AuditStore.asOf in tests.
import { select, antiJoinSuperseded, asOfPredicate, aggregate, parseTime } from './auditdb.js';

export function bruteAsOf(events, account, validTime, txSeq) {
  const validTimeMs = parseTime(validTime, 'validTime');
  const superseded = new Set();
  for (const e of events) {
    if (e.supersedes !== null && e.txSeq <= txSeq) superseded.add(e.supersedes);
  }
  const rows = antiJoinSuperseded(
    select(events, (e) => e.account === account && asOfPredicate(validTimeMs, txSeq)(e)),
    superseded,
  );
  return aggregate(rows);
}
