#!/usr/bin/env node
import fs from 'node:fs';
import { EvidenceStore, EvidenceError } from './store.js';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

const USAGE = `evidence - transactional tamper-evident evidence store

Usage:
  evidence put    --dir D --id ID --submitter NAME --data TEXT [--time ISO]
  evidence put    --dir D --batch-file records.json   # JSON array for a multi-record batch
  evidence get    --dir D --id ID
  evidence list   --dir D [--submitter NAME] [--from ISO] [--to ISO]
  evidence verify --dir D
  evidence cert   --dir D --batch N [--out FILE]

Exit codes: 0 ok, 1 error (TAMPER / NO_CERT / NOT_FOUND / ...), 2 simulated crash.
`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const dir = opts.dir ?? process.env.EVIDENCE_DIR ?? './evidence-db';

  if (!cmd || cmd === 'help') { process.stdout.write(USAGE); return; }

  const store = new EvidenceStore(dir);

  switch (cmd) {
    case 'put': {
      let entries;
      if (opts['batch-file']) {
        entries = JSON.parse(fs.readFileSync(opts['batch-file'], 'utf8'));
      } else {
        entries = [{ id: opts.id, submitter: opts.submitter, data: opts.data, ...(opts.time ? { timestamp: opts.time } : {}) }];
      }
      const cert = store.commit(entries);
      process.stdout.write(JSON.stringify({ committed: cert.batch, headHash: cert.headHash, records: cert.recordCount }) + '\n');
      break;
    }
    case 'get': {
      const rec = store.get(opts.id);
      process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
      break;
    }
    case 'list': {
      const rows = store.list({ submitter: opts.submitter, from: opts.from, to: opts.to });
      process.stdout.write(JSON.stringify(rows.map((r) => ({ id: r.id, submitter: r.submitter, timestamp: r.timestamp, batch: r.batch, data: r.data })), null, 2) + '\n');
      break;
    }
    case 'verify': {
      const res = store.verify();
      process.stdout.write(JSON.stringify(res) + '\n');
      break;
    }
    case 'cert': {
      const batch = Number(opts.batch ?? opts._[0]);
      const cert = store.cert(batch);
      const out = JSON.stringify(cert, null, 2) + '\n';
      if (opts.out) fs.writeFileSync(opts.out, out);
      else process.stdout.write(out);
      break;
    }
    default:
      throw new EvidenceError('USAGE', `unknown command: ${cmd}\n${USAGE}`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof EvidenceError) {
    const extra = err.offset !== undefined ? ` offset=${err.offset}` : err.batch !== undefined ? ` batch=${err.batch}` : '';
    process.stderr.write(`${err.code}: ${err.message}${extra}\n`);
    process.exit(1);
  }
  throw err;
}
