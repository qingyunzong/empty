// Independent reference implementation used to cross-check the library.
// It shares NO code with src/: it works purely in local wall-clock terms,
// enumerates every local minute in the covered range, and never converts
// to UTC or touches the tz tables. Day iteration uses UTC Date math only
// as a calendar (UTC dates have no DST, so +86400000 steps are exact).

export function refIsBusinessDay(calRaw, dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return !(calRaw.weekend ?? [0, 6]).includes(dow) && !calRaw.holidays.includes(dateStr);
}

export function refNextBusinessDay(calRaw, dateStr) {
  let t = Date.parse(dateStr + 'T00:00:00Z');
  for (let i = 0; i < 370; i += 1) {
    t += 86400000;
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > calRaw.horizon) return null;
    if (refIsBusinessDay(calRaw, d)) return d;
  }
  return null;
}

export function refSettlementDate(calRaw, localTime) {
  const [date, hm] = localTime.split('T');
  if (hm >= calRaw.cutoff) return refNextBusinessDay(calRaw, date);
  if (refIsBusinessDay(calRaw, date)) return date <= calRaw.horizon ? date : null;
  return refNextBusinessDay(calRaw, date);
}

// Precompute business-day flags for [fromDate, horizon] so the per-minute
// enumeration below does not re-derive the calendar for every minute.
function buildDayIndex(calRaw, fromDate) {
  const days = [];
  const biz = [];
  const indexOf = new Map();
  let t = Date.parse(fromDate + 'T00:00:00Z');
  const end = Date.parse(calRaw.horizon + 'T00:00:00Z');
  while (t <= end) {
    const d = new Date(t).toISOString().slice(0, 10);
    indexOf.set(d, days.length);
    days.push(d);
    biz.push(refIsBusinessDay(calRaw, d));
    t += 86400000;
  }
  return { days, biz, indexOf };
}

// Map every local minute in [fromDate, toDate] to its settlement date.
export function refMinuteMap(calRaw, fromDate, toDate) {
  const { days, biz, indexOf } = buildDayIndex(calRaw, fromDate);
  const map = new Map();
  const start = Date.parse(fromDate + 'T00:00:00Z');
  const end = Date.parse(toDate + 'T00:00:00Z') + 86400000;
  for (let t = start; t < end; t += 60000) {
    const iso = new Date(t).toISOString();
    const local = iso.slice(0, 10) + 'T' + iso.slice(11, 16);
    const idx = indexOf.get(iso.slice(0, 10));
    let date = null;
    if (idx !== undefined) {
      if (iso.slice(11, 16) >= calRaw.cutoff || !biz[idx]) {
        let j = idx + 1;
        while (j < days.length && !biz[j]) j += 1;
        date = j < days.length ? days[j] : null;
      } else {
        date = days[idx];
      }
    }
    map.set(local, date);
  }
  return map;
}

// Full reference pipeline: minute maps per calendar, then table lookup.
export function refNets(calendarsRaw, flows, fromDate, toDate) {
  const maps = new Map();
  for (const cal of calendarsRaw) maps.set(cal.id, refMinuteMap(cal, fromDate, toDate));
  const acc = new Map();
  const boundaryIds = [];
  const pendingIds = [];
  for (const f of flows) {
    const cal = calendarsRaw.find((c) => c.id === f.calendar);
    const date = maps.get(f.calendar).get(f.localTime);
    if (date === undefined) throw new Error(`reference: minute map does not cover ${f.localTime}`);
    if (date === null) {
      pendingIds.push(f.id);
      continue;
    }
    // A local minute is an interval boundary only when it is the cutoff
    // instant of a business day (interval starts are cutoffs of business days).
    if (f.localTime.slice(11) === cal.cutoff && refIsBusinessDay(cal, f.localTime.slice(0, 10))) {
      boundaryIds.push(f.id);
    }
    const key = [f.calendar, date, f.account, f.currency].join('|');
    acc.set(key, (acc.get(key) ?? 0) + f.amount);
  }
  const nets = [...acc.entries()]
    .map(([key, net]) => {
      const [calendar, date, account, currency] = key.split('|');
      return { calendar, date, account, currency, net };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { nets, boundaryIds: boundaryIds.sort(), pendingIds: pendingIds.sort() };
}
