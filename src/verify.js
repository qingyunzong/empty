import { hashRecord } from './record.js';
import { dedupeByHash, chainHead } from './log.js';

export const EXIT_OK = 0;
export const EXIT_BROKEN_CHAIN = 15;
export const EXIT_LOW_GEN_BACKFILL = 16;

function failure(status, exitCode, detail, records) {
  return {
    exitCode,
    certificate: {
      status,
      error: detail,
      head: chainHead(records),
      records: records.length,
      missing: [],
      masked: [],
    },
  };
}

export function verifyRecords(input) {
  const records = dedupeByHash(input);

  for (const record of records) {
    if (typeof record.hash !== 'string' || hashRecord(record) !== record.hash) {
      return failure('broken', EXIT_BROKEN_CHAIN, `hash mismatch on record ${record.hash ?? '<none>'} (site ${record.site})`, records);
    }
  }

  const byHash = new Map(records.map((r) => [r.hash, r]));
  const bySite = new Map();
  for (const record of records) {
    if (!bySite.has(record.site)) bySite.set(record.site, []);
    bySite.get(record.site).push(record);
  }

  for (const [site, list] of bySite) {
    const byCounter = new Map();
    for (const record of list) {
      const counter = record.vc?.[site];
      if (!Number.isInteger(counter) || counter < 1) {
        return failure('broken', EXIT_BROKEN_CHAIN, `record ${record.hash} of site ${site} has no valid own vector counter`, records);
      }
      if (byCounter.has(counter)) {
        return failure('broken', EXIT_BROKEN_CHAIN, `fork on site ${site} at counter ${counter}`, records);
      }
      byCounter.set(counter, record);
    }
    bySite.set(site, [...byCounter.values()].sort((a, b) => a.vc[site] - b.vc[site]));
  }

  const missing = [];
  const missingKeys = new Set();
  const addMissing = (entry) => {
    const key = JSON.stringify(entry);
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missing.push(entry);
  };

  const maxCounter = new Map();
  for (const [site, list] of bySite) {
    maxCounter.set(site, list.length === 0 ? 0 : list[list.length - 1].vc[site]);
  }

  for (const [site, list] of bySite) {
    let previous = null;
    for (const record of list) {
      const counter = record.vc[site];
      if (previous === null) {
        if (record.prev !== null) {
          if (byHash.has(record.prev)) {
            return failure('broken', EXIT_BROKEN_CHAIN, `first known record ${record.hash} of site ${site} points at in-log prev`, records);
          }
          addMissing({ kind: 'prev', site, counter, prev: record.prev });
        }
        if (counter !== 1) {
          addMissing({ kind: 'counters', site, from: 1, to: counter - 1 });
        }
      } else {
        const expectedCounter = previous.vc[site] + 1;
        if (counter !== expectedCounter) {
          addMissing({ kind: 'counters', site, from: expectedCounter, to: counter - 1 });
        }
        if (record.prev !== previous.hash) {
          if (byHash.has(record.prev)) {
            return failure('broken', EXIT_BROKEN_CHAIN, `record ${record.hash} of site ${site} prev does not match chain predecessor`, records);
          }
          addMissing({ kind: 'prev', site, counter, prev: record.prev });
        }
      }
      previous = record;
    }
  }

  for (const record of records) {
    for (const [site, value] of Object.entries(record.vc)) {
      if (site === record.site) continue;
      const have = maxCounter.get(site) ?? 0;
      if (value > have) {
        addMissing({ kind: 'causal', site, from: have + 1, to: value, seenBy: record.hash });
      }
    }
  }

  for (const [site, list] of bySite) {
    const exits = list.filter((r) => r.type === 'exit').sort((a, b) => a.gen - b.gen || (a.hash < b.hash ? -1 : 1));
    for (const exit of exits) {
      const seal = exit.payload?.seal;
      if (!seal || !Number.isInteger(seal.count)) {
        return failure('broken', EXIT_BROKEN_CHAIN, `exit record ${exit.hash} of site ${site} lacks a seal`, records);
      }
      const sealed = list.filter((r) => r !== exit && r.gen <= exit.gen && r.type !== 'join');
      for (const record of sealed) {
        if (record.vc[site] > seal.count) {
          return failure('rejected', EXIT_LOW_GEN_BACKFILL, `low-generation backfill: record ${record.hash} of site ${site} (gen ${record.gen}, counter ${record.vc[site]}) exceeds exit seal count ${seal.count} at gen ${exit.gen}`, records);
        }
      }
      const atSeal = list.find((r) => r.vc[site] === seal.count && r !== exit);
      if (seal.count > 0) {
        if (atSeal && seal.head !== null && atSeal.hash !== seal.head) {
          return failure('broken', EXIT_BROKEN_CHAIN, `exit seal head mismatch on site ${site} at counter ${seal.count}`, records);
        }
        if (!atSeal) {
          addMissing({ kind: 'seal', site, counter: seal.count, head: seal.head });
        }
      }
    }
  }

  for (const [site, list] of bySite) {
    let lastGen = 0;
    for (const record of list) {
      if (record.gen < lastGen) {
        return failure('broken', EXIT_BROKEN_CHAIN, `gen decreases along chain of site ${site} at record ${record.hash}`, records);
      }
      lastGen = record.gen;
    }
  }

  const tombstones = records
    .filter((r) => r.type === 'tombstone')
    .sort((a, b) => a.gen - b.gen || (a.hash < b.hash ? -1 : 1));
  const effectByTarget = new Map();
  const revokedTombstones = new Set();
  for (const tombstone of tombstones) {
    const target = tombstone.payload?.target;
    if (typeof target !== 'string') {
      return failure('broken', EXIT_BROKEN_CHAIN, `tombstone ${tombstone.hash} lacks a target`, records);
    }
    if (!byHash.has(target)) {
      addMissing({ kind: 'tombstone-target', site: tombstone.site, target, by: tombstone.hash });
      continue;
    }
    if (byHash.get(target).type === 'tombstone') revokedTombstones.add(target);
    effectByTarget.set(target, tombstone);
  }

  const masked = [];
  for (const [target, tombstone] of [...effectByTarget.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (revokedTombstones.has(tombstone.hash)) continue;
    masked.push({
      hash: target,
      type: byHash.get(target).type,
      by: tombstone.hash,
      gen: tombstone.gen,
      scope: tombstone.payload?.scope ?? 'full',
      reason: tombstone.payload?.reason ?? null,
    });
  }

  const certificate = {
    status: missing.length > 0 ? 'unknown' : 'ok',
    head: chainHead(records),
    records: records.length,
    sites: [...bySite.keys()].sort(),
    missing,
    masked,
    effective: records.length - masked.length,
  };
  return { exitCode: EXIT_OK, certificate };
}
