import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionProcessor, normalizeRecord } from '../src/sessions.js';

// ---------------------------------------------------------------------------
// Independent brute-force reference implementation.
// Written separately from src/sessions.js on purpose: it replays the whole
// record stream, sorts the live points of each station, enumerates every
// valid gap grouping by recursive search, and computes means from scratch.
// ---------------------------------------------------------------------------

const REF_GAP_MS = 10 * 60 * 1000;

function refParseTime(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

// Enumerate all groupings of the sorted timestamps where every in-group
// adjacent gap is <= REF_GAP_MS and every group boundary is a gap larger
// than REF_GAP_MS. Returns the list of valid groupings (each grouping is a
// list of groups of indices).
function refEnumerateGroupings(sortedTimes) {
  const n = sortedTimes.length;
  if (n === 0) return [[]];
  const valid = [];
  const cuts = new Array(n - 1).fill(false);
  const search = (i) => {
    if (i === n - 1) {
      const groups = [];
      let group = [0];
      for (let k = 0; k < n - 1; k += 1) {
        if (cuts[k]) {
          groups.push(group);
          group = [];
        }
        group.push(k + 1);
      }
      groups.push(group);
      valid.push(groups);
      return;
    }
    const gap = sortedTimes[i + 1] - sortedTimes[i];
    // Try cutting here (only legal when the gap is too large to merge)...
    if (gap > REF_GAP_MS) {
      cuts[i] = true;
      search(i + 1);
    }
    // ...and try not cutting (only legal when the gap must merge).
    if (gap <= REF_GAP_MS) {
      cuts[i] = false;
      search(i + 1);
    }
  };
  search(0);
  return valid;
}

function refReplay(rawRecords) {
  const table = new Map(); // id -> { station, t, temp, version, state }
  let watermark = null;
  const emitted = [];
  const errors = [];

  for (const raw of rawRecords) {
    if (raw.op === 'WATERMARK') {
      const ts = refParseTime(raw.ts);
      if (watermark === null || ts > watermark) watermark = ts;
      const stations = new Map();
      for (const row of table.values()) {
        if (row.state !== 'live') continue;
        if (!stations.has(row.station)) stations.set(row.station, []);
        stations.get(row.station).push(row);
      }
      const finalized = [];
      for (const [station, rows] of stations) {
        rows.sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
        const groupings = refEnumerateGroupings(rows.map((r) => r.t));
        assert.equal(groupings.length, 1, 'reference expects exactly one valid grouping');
        for (const group of groupings[0]) {
          const members = group.map((i) => rows[i]);
          const lastT = members[members.length - 1].t;
          if (watermark > lastT + REF_GAP_MS) {
            let sum = 0;
            let version = 0;
            const ids = [];
            for (const m of members) {
              sum += m.temp;
              version = Math.max(version, m.version);
              ids.push(m.id);
              m.state = 'finalized';
            }
            finalized.push({
              station,
              start: new Date(members[0].t).toISOString(),
              end: new Date(lastT).toISOString(),
              count: members.length,
              avgTemp: Math.round((sum / members.length) * 1e6) / 1e6,
              ids,
              version,
            });
          }
        }
      }
      finalized.sort((a, b) => a.start.localeCompare(b.start) || a.station.localeCompare(b.station));
      emitted.push(...finalized);
    } else if (raw.op === 'UPSERT') {
      const t = refParseTime(raw.eventTime);
      const known = table.get(raw.id);
      if (known && raw.version < known.version) {
        errors.push('STALE_VERSION');
      } else if (known && raw.version === known.version) {
        // idempotent
      } else if (watermark !== null && t <= watermark) {
        errors.push('LATE');
      } else {
        table.set(raw.id, { id: raw.id, station: raw.station, t, temp: raw.temp, version: raw.version, state: 'live' });
      }
    } else if (raw.op === 'RETRACT') {
      const known = table.get(raw.id);
      if (!known) {
        errors.push('UNKNOWN_RETRACT');
      } else if (raw.version < known.version) {
        errors.push('STALE_VERSION');
      } else if (known.state === 'retracted' && raw.version === known.version) {
        // idempotent
      } else if (known.state === 'finalized' ||
                 (known.state === 'live' && watermark !== null && known.t <= watermark)) {
        errors.push('LATE');
      } else {
        known.state = 'retracted';
        known.version = raw.version;
      }
    } else {
      throw new Error(`reference: unexpected op ${raw.op}`);
    }
  }
  return { emitted, errors };
}

// Runs the real implementation over the same raw records.
function implReplay(rawRecords) {
  const processor = new SessionProcessor();
  const emitted = [];
  const errors = [];
  for (const raw of rawRecords) {
    const { emitted: out, error } = processor.process(normalizeRecord(raw));
    emitted.push(...out);
    if (error) errors.push(error.code);
  }
  return { emitted, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60 * 1000;

function upsert(id, station, minute, temp, version = 1) {
  return { op: 'UPSERT', id, station, eventTime: new Date(T0 + minute * MIN).toISOString(), temp, version };
}

function retract(id, version = 1) {
  return { op: 'RETRACT', id, version };
}

function watermark(minute) {
  return { op: 'WATERMARK', ts: new Date(T0 + minute * MIN).toISOString() };
}

// ---------------------------------------------------------------------------
// Acceptance tests
// ---------------------------------------------------------------------------

test('out-of-order upserts merge two sessions into one', () => {
  const records = [
    upsert('a', 's1', 0, 10),
    upsert('c', 's1', 15, 30), // gap of 15 min: second session
    upsert('b', 's1', 8, 20),  // arrives late but bridges the gap (0-8-15)
    watermark(26),             // 26 > 15 + 10: finalizes the merged session
  ];
  const { emitted, errors } = implReplay(records);
  assert.deepEqual(errors, []);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    station: 's1',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-01T00:15:00.000Z',
    count: 3,
    avgTemp: 20,
    ids: ['a', 'b', 'c'],
    version: 1,
  });
  assert.deepEqual(implReplay(records), refReplay(records));
});

test('retract of a middle observation splits one session into two', () => {
  const records = [
    upsert('a', 's1', 0, 10),
    upsert('b', 's1', 6, 20),
    upsert('c', 's1', 12, 30),
    retract('b'),              // removes the bridge: [0] and [12] split apart
    watermark(23),             // 23 > 12 + 10: both sessions finalize
  ];
  const { emitted, errors } = implReplay(records);
  assert.deepEqual(errors, []);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[0].ids, ['a']);
  assert.deepEqual(emitted[1].ids, ['c']);
  assert.equal(emitted[0].avgTemp, 10);
  assert.equal(emitted[1].avgTemp, 30);
  assert.deepEqual(implReplay(records), refReplay(records));
});

test('late events and unknown retracts are rejected without changing state', () => {
  const records = [
    upsert('a', 's1', 0, 10),
    upsert('b', 's1', 5, 20),
    watermark(16),             // finalizes [a, b] (16 > 5 + 10)
    upsert('c', 's1', 10, 99), // LATE: 10 <= watermark 16
    retract('ghost'),          // UNKNOWN_RETRACT
    retract('a'),              // LATE: already finalized
    upsert('d', 's1', 40, 40), // new session, after the watermark
  ];
  const processor = new SessionProcessor();
  const emitted = [];
  const codes = [];
  for (const raw of records) {
    const result = processor.process(normalizeRecord(raw));
    emitted.push(...result.emitted);
    if (result.error) codes.push(result.error.code);
  }
  assert.deepEqual(codes, ['LATE', 'UNKNOWN_RETRACT', 'LATE']);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].ids, ['a', 'b']);
  assert.equal(emitted[0].avgTemp, 15);

  // State must be unchanged by the rejected records: a later watermark only
  // finalizes the untouched [d] session, nothing else.
  const again = processor.process(normalizeRecord(watermark(51)));
  assert.equal(again.error, null);
  assert.equal(again.emitted.length, 1);
  assert.deepEqual(again.emitted[0].ids, ['d']);
  assert.equal(again.emitted[0].avgTemp, 40);

  assert.deepEqual(implReplay(records), refReplay(records));
});

test('version rules: stale rejected, same version idempotent, higher wins', () => {
  const records = [
    upsert('a', 's1', 0, 10, 2),
    upsert('a', 's1', 0, 10, 2),  // idempotent replay
    upsert('a', 's1', 0, 99, 1),  // STALE_VERSION
    upsert('a', 's1', 1, 30, 3),  // higher version updates temp/time
    retract('a', 2),              // STALE_VERSION
    retract('a', 3),              // retracts the live observation
    retract('a', 3),              // idempotent replay of the retract
    watermark(20),
  ];
  const { emitted, errors } = implReplay(records);
  assert.deepEqual(errors, ['STALE_VERSION', 'STALE_VERSION']);
  assert.deepEqual(emitted, []); // nothing live left to finalize
  assert.deepEqual(implReplay(records), refReplay(records));
});

test('watermark only finalizes sessions strictly beyond max event time + gap', () => {
  const records = [
    upsert('a', 's1', 0, 10),
    watermark(10), // 10 > 0 + 10 is false: not finalized yet
    watermark(11), // 11 > 10: finalized
  ];
  const processor = new SessionProcessor();
  let out = processor.process(normalizeRecord(records[0]));
  out = processor.process(normalizeRecord(records[1]));
  assert.deepEqual(out.emitted, []);
  out = processor.process(normalizeRecord(records[2]));
  assert.equal(out.emitted.length, 1);
  assert.deepEqual(out.emitted[0].ids, ['a']);
});

// ---------------------------------------------------------------------------
// Randomized differential test against the brute-force reference (<= 40 rows)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStream(rand) {
  const stations = ['s1', 's2', 's3'];
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const records = [];
  const total = 20 + Math.floor(rand() * 21); // 20..40 records
  for (let i = 0; i < total; i += 1) {
    const roll = rand();
    if (roll < 0.62) {
      records.push(upsert(
        ids[Math.floor(rand() * ids.length)],
        stations[Math.floor(rand() * stations.length)],
        Math.floor(rand() * 90),
        Math.round(rand() * 600) / 10 - 10,
        1 + Math.floor(rand() * 3),
      ));
    } else if (roll < 0.82) {
      records.push(retract(ids[Math.floor(rand() * ids.length)], 1 + Math.floor(rand() * 3)));
    } else {
      records.push(watermark(Math.floor(rand() * 120)));
    }
  }
  return records;
}

test('random streams (<= 40 records) match the brute-force reference', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const records = randomStream(mulberry32(seed));
    assert.ok(records.length <= 40);
    assert.deepEqual(implReplay(records), refReplay(records), `seed ${seed}`);
  }
});
