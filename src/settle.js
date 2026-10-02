// Append-only settlement engine. History is never mutated: corrections are
// new reversal flows; applying a batch recomputes only the settlement days
// the batch touches and leaves all other days' results untouched.
import { errInput, errOrder } from './errors.js';
import { parseLocal, formatDate, parseDate, formatUtc } from './civil.js';
import { resolveLocal } from './tztable.js';
import { settlementDateFor, settlementInterval, mergeIntervals } from './calendar.js';
import { canonicalize, hashObject, sha256Hex } from './canon.js';

export const PENDING_CALENDAR_HORIZON = 'CALENDAR_HORIZON';

export function createState() {
  return {
    lastSeq: 0,
    flowsChain: sha256Hex('clearing-daycut/genesis'),
    knownIds: [],
    days: {},
    boundaryHits: [],
    pending: [],
  };
}

function normalizeFlow(raw, index) {
  const what = `flows[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw errInput(`${what}: must be an object`);
  if (typeof raw.id !== 'string' || raw.id.length === 0) throw errInput(`${what}: "id" must be a non-empty string`);
  if (!Number.isInteger(raw.seq) || raw.seq < 1) throw errInput(`${what}: "seq" must be a positive integer`);
  if (typeof raw.account !== 'string' || raw.account.length === 0) throw errInput(`${what}: "account" must be a non-empty string`);
  if (typeof raw.calendar !== 'string' || raw.calendar.length === 0) throw errInput(`${what}: "calendar" must be a non-empty string`);
  if (raw.type !== 'post' && raw.type !== 'reversal') throw errInput(`${what}: "type" must be "post" or "reversal"`);
  if (!Number.isInteger(raw.amount)) throw errInput(`${what}: "amount" must be an integer (minor units)`);
  if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) throw errInput(`${what}: "currency" must be ISO-4217 uppercase`);
  const localMin = parseLocal(raw.localTime, `${what}.localTime`);
  if (raw.type === 'reversal' && (typeof raw.ref !== 'string' || raw.ref.length === 0)) {
    throw errInput(`${what}: reversal requires "ref" (id of the original flow)`);
  }
  return {
    id: raw.id,
    seq: raw.seq,
    account: raw.account,
    calendar: raw.calendar,
    type: raw.type,
    amount: raw.amount,
    currency: raw.currency,
    localTime: raw.localTime,
    localMin,
    ...(raw.type === 'reversal' ? { ref: raw.ref } : {}),
  };
}

// Apply one append-only batch. `state` is updated in place and also returned.
export function applyFlows({ tzTable, calendars, flows, state }) {
  if (!Array.isArray(flows)) throw errInput('flows must be an array');
  const known = new Set(state.knownIds);
  const affected = new Map(); // calId -> Set(date)
  const newPending = [];

  flows.forEach((raw, index) => {
    const f = normalizeFlow(raw, index);
    if (f.seq <= state.lastSeq) {
      throw errOrder(`flow ${f.id}: seq ${f.seq} is not after last applied seq ${state.lastSeq}`, { id: f.id, seq: f.seq, lastSeq: state.lastSeq });
    }
    if (known.has(f.id)) throw errOrder(`flow ${f.id}: duplicate id`, { id: f.id });
    if (f.type === 'reversal' && !known.has(f.ref)) {
      throw errOrder(`flow ${f.id}: reversal references unknown flow ${f.ref}`, { id: f.id, ref: f.ref });
    }
    const cal = calendars.get(f.calendar);
    if (!cal) throw errInput(`flow ${f.id}: unknown calendar ${JSON.stringify(f.calendar)}`, { id: f.id, calendar: f.calendar });

    // Local -> UTC. E_GAP / E_OVERLAP / E_TZ_UNKNOWN propagate: illegal or
    // ambiguous local times are rejected, never silently shifted.
    const { utcMin } = resolveLocal(tzTable, cal.zone, f.localMin);

    const dateDay = settlementDateFor(cal, f.localMin);
    if (dateDay === null) {
      newPending.push({ id: f.id, calendar: cal.id, localTime: f.localTime, reason: PENDING_CALENDAR_HORIZON });
    } else {
      const date = formatDate(dateDay);
      const iv = settlementInterval(tzTable, cal, dateDay);
      if (utcMin < iv.startUtcMin || utcMin >= iv.endUtcMin) {
        throw errInput(`flow ${f.id}: instant outside settlement interval (calendar/tz data inconsistent)`, { id: f.id });
      }
      if (utcMin === iv.startUtcMin) {
        state.boundaryHits.push({ id: f.id, calendar: cal.id, utc: formatUtc(utcMin), date, rule: 'half-open: instant == localStart belongs to this day' });
      }
      const days = (state.days[cal.id] ??= {});
      const day = (days[date] ??= { entries: [], nets: {} });
      day.entries.push({ id: f.id, account: f.account, currency: f.currency, amount: f.amount, type: f.type, ...(f.ref ? { ref: f.ref } : {}) });
      if (!affected.has(cal.id)) affected.set(cal.id, new Set());
      affected.get(cal.id).add(date);
    }

    known.add(f.id);
    state.knownIds.push(f.id);
    state.lastSeq = f.seq;
    // Per-flow hash chain: independent of how flows are grouped into batches,
    // so incremental application and full replay commit to the same history.
    state.flowsChain = sha256Hex(state.flowsChain + canonicalize(f));
  });

  // Recompute nets for affected days only; untouched days keep prior results.
  const affectedDays = [];
  for (const [calId, dates] of [...affected.entries()].sort()) {
    for (const date of [...dates].sort()) {
      const day = state.days[calId][date];
      const nets = {};
      for (const e of day.entries) {
        const key = `${e.account}|${e.currency}`;
        nets[key] = (nets[key] ?? 0) + e.amount;
      }
      day.nets = nets;
      affectedDays.push({ calendar: calId, date });
    }
  }

  state.pending.push(...newPending);
  return { state, affectedDays, pending: newPending };
}

export function computeNets(state) {
  const rows = [];
  for (const calId of Object.keys(state.days).sort()) {
    for (const date of Object.keys(state.days[calId]).sort()) {
      const nets = state.days[calId][date].nets;
      for (const key of Object.keys(nets).sort()) {
        const [account, currency] = key.split('|');
        rows.push({ calendar: calId, date, account, currency, net: nets[key] });
      }
    }
  }
  return rows;
}

// Merged settlement-interval proof per calendar (certificate material).
export function computeMergedIntervals(tzTable, calendars, state) {
  const out = [];
  for (const calId of Object.keys(state.days).sort()) {
    const cal = calendars.get(calId);
    const intervals = Object.keys(state.days[calId])
      .sort()
      .map((date) => settlementInterval(tzTable, cal, parseDate(date)));
    for (const m of mergeIntervals(intervals)) {
      out.push({
        calendar: calId,
        fromDate: m.fromDate,
        toDate: m.toDate,
        dayCount: m.dayCount,
        startUtc: formatUtc(m.startUtcMin),
        endUtc: formatUtc(m.endUtcMin),
      });
    }
  }
  return out;
}
