import fs from 'node:fs';
import { EngineError } from './errors.js';

// The journal is an append-only JSONL file. A crash "during checkpoint write"
// can leave a torn (partial) final line; readers tolerate it and recovery
// truncates it before appending again.

export function readJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return { records: [], torn: false, maxSeq: 0 };
  return parseJournal(fs.readFileSync(journalPath, 'utf8'));
}

export function parseJournal(raw) {
  const records = [];
  let torn = false;
  let maxSeq = 0;
  if (raw.length === 0) return { records, torn, maxSeq };
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      if (i === lines.length - 1) {
        torn = true;
        break;
      }
      throw new EngineError('JOURNAL_CORRUPT', `journal corrupt at line ${i + 1}`);
    }
    records.push(rec);
    if (typeof rec.seq === 'number' && rec.seq > maxSeq) maxSeq = rec.seq;
  }
  return { records, torn, maxSeq };
}

export function truncateTornTail(journalPath) {
  const raw = fs.readFileSync(journalPath, 'utf8');
  const idx = raw.lastIndexOf('\n');
  fs.writeFileSync(journalPath, idx === -1 ? '' : raw.slice(0, idx + 1));
}

export function ensureTrailingNewline(journalPath) {
  const raw = fs.readFileSync(journalPath, 'utf8');
  if (raw.length > 0 && !raw.endsWith('\n')) fs.appendFileSync(journalPath, '\n');
}
