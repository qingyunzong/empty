import { readFileSync, writeFileSync } from 'node:fs';
import { makeRecord, sha256hex, canonical } from './record.js';

export function readJsonl(path) {
  const text = readFileSync(path, 'utf8');
  const records = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      throw new Error(`${path}:${index + 1}: invalid JSON line`);
    }
  }
  return records;
}

export function writeJsonl(path, records) {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, text === '' ? '' : text + '\n');
}

export function nextVc(records, site) {
  const vc = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record.vc ?? {})) {
      vc[key] = Math.max(vc[key] ?? 0, value);
    }
  }
  vc[site] = (vc[site] ?? 0) + 1;
  return vc;
}

export function lastRecordOfSite(records, site) {
  let best = null;
  for (const record of records) {
    if (record.site !== site) continue;
    if (best === null || (record.vc?.[site] ?? 0) > (best.vc?.[site] ?? 0)) best = record;
  }
  return best;
}

export function appendRecord(records, { type, site, gen, payload }) {
  const previous = lastRecordOfSite(records, site);
  const body = { type, site, gen, vc: nextVc(records, site), prev: previous ? previous.hash : null, payload };
  if (type === 'exit' && (body.payload == null || body.payload.seal == null)) {
    body.payload = {
      ...(body.payload ?? {}),
      seal: { count: previous ? previous.vc[site] : 0, head: previous ? previous.hash : null },
    };
  }
  return makeRecord(body);
}

export function dedupeByHash(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    if (seen.has(record.hash)) continue;
    seen.add(record.hash);
    out.push(record);
  }
  return out;
}

export function canonicalOrder(records) {
  const remaining = new Map(records.map((r) => [r.hash, r]));
  const placed = new Set();
  const placedVc = {};
  const out = [];
  for (;;) {
    let best = null;
    for (const record of remaining.values()) {
      if (record.prev !== null && !placed.has(record.prev)) continue;
      let ready = true;
      for (const [key, value] of Object.entries(record.vc)) {
        if (key === record.site) {
          if (value !== (placedVc[key] ?? 0) + 1) { ready = false; break; }
        } else if (value > (placedVc[key] ?? 0)) { ready = false; break; }
      }
      if (!ready) continue;
      if (best === null || record.hash < best.hash) best = record;
    }
    if (best === null) break;
    out.push(best);
    placed.add(best.hash);
    remaining.delete(best.hash);
    for (const [key, value] of Object.entries(best.vc)) {
      placedVc[key] = Math.max(placedVc[key] ?? 0, value);
    }
  }
  const orphans = [...remaining.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  return [...out, ...orphans];
}

export function chainHead(records) {
  const hashes = records.map((r) => r.hash).sort();
  return sha256hex(canonical(hashes));
}
