import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { canonical } from './canon.js';
import { createRecord, vcMerge } from './record.js';

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const records = [];
  for (const [i, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      throw new Error(`${file}:${i + 1}: invalid JSON line: ${err.message}`);
    }
  }
  return records;
}

export function writeJsonl(file, records) {
  const text = records.map((r) => canonical(r)).join('\n');
  writeFileSync(file, text === '' ? '' : text + '\n');
}

// Append a record for `site` to a JSONL log file. The log may already contain
// records from other sites (e.g. previously merged in); the new record's
// vector clock covers everything currently in the file.
export function appendToLog(file, { site, epoch, type, payload = null, target = null, scope = null }) {
  const existing = readJsonl(file);
  const knowledge = {};
  let prev = null;
  for (const rec of existing) {
    vcMerge(knowledge, rec.vc);
    if (rec.site === site) prev = rec.hash;
  }
  const rec = createRecord({ site, epoch, type, payload, target, scope, prev, knowledge });
  appendFileSync(file, canonical(rec) + '\n');
  return rec;
}
