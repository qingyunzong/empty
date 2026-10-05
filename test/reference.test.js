import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../lib/engine.js';
import { TzTable } from '../lib/tz.js';
import { CalendarSet } from '../lib/calendar.js';
import { formatUtcMinutes, dayNumberToDate, parseUtcMinutes } from '../lib/time.js';
import { TZ, CAL, mulberry32 } from './helpers.js';

// Independent reference algorithm: for each candidate settlement day D,
// enumerate EVERY local minute of the half-open interval
// [cutoff(prevBusinessDay(D)), cutoff(D)), convert each minute to UTC on its
// own, and check membership. No interval arithmetic is shared with the engine.
function referenceSettlementDay(tz, cals, cal, instantMin) {
  const localMin = tz.utcToLocal(cal.zone, instantMin);
  const approxDay = Math.floor(localMin / 1440);
  for (let d = approxDay - 2; d <= approxDay + 10; d += 1) {
    if (!cals.isBusinessDay(cal, d)) continue;
    const prev = cals.prevBusinessDay(cal, d);
    const startLocal = prev * 1440 + cal.cutoff;
    const endLocal = d * 1440 + cal.cutoff;
    for (let m = startLocal; m < endLocal; m += 1) {
      const candidates = tz.localToUtcCandidates(cal.zone, m);
      if (candidates.includes(instantMin)) return d;
    }
  }
  throw new Error(`reference: no settlement day found for ${formatUtcMinutes(instantMin)}`);
}

// Acceptance 4: small random ledger compared against the independent
// local-minute enumeration reference, including across DST transitions.
test('random ledger matches independent local-minute enumeration reference', () => {
  const tz = new TzTable(TZ);
  const cals = new CalendarSet(CAL, tz);
  const rand = mulberry32(20240610);
  const calIds = ['NY', 'LN', 'SH'];
  const accounts = ['alpha', 'beta', 'gamma'];

  // Random instants across Mar..Nov 2024 (covers both DST transitions).
  const start = Date.UTC(2024, 2, 1) / 60000;
  const span = Math.floor((Date.UTC(2024, 10, 30) - Date.UTC(2024, 2, 1)) / 60000);
  const txs = [];
  let t = start;
  for (let i = 0; i < 240; i += 1) {
    t += 1 + Math.floor(rand() * 3600); // keep timestamps non-decreasing
    if (t > start + span) break;
    txs.push({
      id: `tx${i}`,
      account: accounts[Math.floor(rand() * accounts.length)],
      calendar: calIds[Math.floor(rand() * calIds.length)],
      amount: Math.floor(rand() * 200001) - 100000,
      utc: formatUtcMinutes(t),
    });
  }
  assert.ok(txs.length > 100, 'expected a decent sample size');

  const engine = new ClearingEngine({ tzTable: TZ, calendar: CAL });
  const report = engine.settle(txs);

  // 1) Per-tx settlement day: engine vs reference enumeration.
  const expectedNets = new Map(); // "cal|day|account" -> net
  for (const tx of txs) {
    const cal = cals.get(tx.calendar);
    const instant = parseUtcMinutes(tx.utc);
    const engineDay = engine.settlementDay(cal, instant).dayNum;
    const refDay = referenceSettlementDay(tz, cals, cal, instant);
    assert.equal(
      dayNumberToDate(engineDay),
      dayNumberToDate(refDay),
      `mismatch for ${tx.id} at ${tx.utc} in ${tx.calendar}`,
    );
    const key = `${tx.calendar}|${dayNumberToDate(refDay)}|${tx.account}`;
    expectedNets.set(key, (expectedNets.get(key) ?? 0) + tx.amount);
  }

  // 2) Aggregated nets: engine report vs reference aggregation.
  const actualNets = new Map();
  for (const n of report.nets) actualNets.set(`${n.calendar}|${n.day}|${n.account}`, n.net);
  assert.deepEqual(Object.fromEntries(actualNets), Object.fromEntries(expectedNets));
});
