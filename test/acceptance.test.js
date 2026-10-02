import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyFlows, computeNets } from '../src/settle.js';
import { resolveLocal } from '../src/tztable.js';
import { parseLocal } from '../src/civil.js';
import { refNets } from './reference.js';
import { freshInputs, calendarsRaw, mulberry32 } from './helpers.js';

test('acceptance 1: same UTC instant, three markets, three cut results', () => {
  const { tzTable, calendars } = freshInputs();
  // One instant: 2024-06-10T15:00Z rendered in each market's local time.
  const legs = [
    { id: 'ny', calendar: 'US-NY', zone: 'America/New_York', localTime: '2024-06-10T11:00', currency: 'USD', expectDate: '2024-06-10' },
    { id: 'lon', calendar: 'GB-LON', zone: 'Europe/London', localTime: '2024-06-10T16:00', currency: 'GBP', expectDate: '2024-06-10' },
    { id: 'sha', calendar: 'CN-SHA', zone: 'Asia/Shanghai', localTime: '2024-06-10T23:00', currency: 'CNY', expectDate: '2024-06-11' },
  ];
  // Sanity: all three local renderings are the same UTC instant.
  const utcs = legs.map((l) => resolveLocal(tzTable, l.zone, parseLocal(l.localTime)).utcMin);
  assert.ok(utcs[0] === utcs[1] && utcs[1] === utcs[2]);

  const state = createState();
  applyFlows({
    tzTable, calendars, state,
    flows: legs.map((l, i) => ({
      id: l.id, seq: i + 1, account: 'ACME', calendar: l.calendar, type: 'post',
      amount: 100000, currency: l.currency, localTime: l.localTime,
    })),
  });
  const nets = computeNets(state);
  for (const leg of legs) {
    const row = nets.find((n) => n.calendar === leg.calendar);
    assert.equal(row.date, leg.expectDate, `${leg.calendar} should settle on ${leg.expectDate}`);
    assert.equal(row.net, 100000);
  }
});

test('acceptance 2: DST gap and overlap flows are rejected, never shifted', () => {
  const { tzTable, calendars } = freshInputs();
  const gapFlow = [{
    id: 'gap-1', seq: 1, account: 'A', calendar: 'US-NY', type: 'post',
    amount: 100, currency: 'USD', localTime: '2024-03-10T02:30', // vanished in spring forward
  }];
  let err1;
  assert.throws(
    () => applyFlows({ tzTable, calendars, flows: gapFlow, state: createState() }),
    (e) => { err1 = e; return e.code === 'E_GAP'; },
  );
  assert.match(err1.message, /does not exist/);

  const overlapFlow = [{
    id: 'ovl-1', seq: 1, account: 'A', calendar: 'US-NY', type: 'post',
    amount: 100, currency: 'USD', localTime: '2024-11-03T01:30', // happens twice in fall back
  }];
  let err2;
  assert.throws(
    () => applyFlows({ tzTable, calendars, flows: overlapFlow, state: createState() }),
    (e) => { err2 = e; return e.code === 'E_OVERLAP'; },
  );
  assert.match(err2.message, /ambiguous/);
});

function randomFlows(seed, count) {
  const rand = mulberry32(seed);
  const cals = [
    { id: 'US-NY', currency: 'USD' },
    { id: 'GB-LON', currency: 'GBP' },
    { id: 'CN-SHA', currency: 'CNY' },
  ];
  const flows = [];
  const base = Date.parse('2024-06-01T00:00:00Z');
  for (let i = 0; i < count; i += 1) {
    const cal = cals[Math.floor(rand() * cals.length)];
    const day = new Date(base + Math.floor(rand() * 181) * 86400000).toISOString().slice(0, 10);
    const hh = String(6 + Math.floor(rand() * 17)).padStart(2, '0'); // 06..22 avoids DST twilight hours
    const mm = String(Math.floor(rand() * 60)).padStart(2, '0');
    const account = `ACC${1 + Math.floor(rand() * 4)}`;
    const isReversal = flows.length > 0 && rand() < 0.05;
    if (isReversal) {
      const orig = flows[Math.floor(rand() * flows.length)];
      flows.push({
        id: `f${i}`, seq: i + 1, account: orig.account, calendar: orig.calendar, type: 'reversal',
        amount: -orig.amount, currency: orig.currency, localTime: `${day}T${hh}:${mm}`, ref: orig.id,
      });
    } else {
      flows.push({
        id: `f${i}`, seq: i + 1, account, calendar: cal.id, type: 'post',
        amount: Math.floor(rand() * 200000) - 100000, currency: cal.currency, localTime: `${day}T${hh}:${mm}`,
      });
    }
  }
  return flows;
}

for (const seed of [42, 1337, 20240610]) {
  test(`acceptance 4: random batch (seed ${seed}) matches minute-enumeration reference`, () => {
    const { tzTable, calendars } = freshInputs();
    const flows = randomFlows(seed, 300);
    const state = createState();
    applyFlows({ tzTable, calendars, flows, state });

    const libNets = computeNets(state).map((r) => JSON.stringify(r)).sort();
    const ref = refNets(calendarsRaw, flows, '2024-05-31', '2024-12-02');
    const refNetsSorted = ref.nets.map((r) => JSON.stringify(r)).sort();
    assert.deepEqual(libNets, refNetsSorted);

    const libBoundary = state.boundaryHits.map((h) => h.id).sort();
    assert.deepEqual(libBoundary, ref.boundaryIds);
    assert.deepEqual(state.pending.map((p) => p.id).sort(), ref.pendingIds);
  });
}
