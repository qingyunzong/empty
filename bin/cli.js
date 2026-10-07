#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { EvidenceStore, StoreError } = require('../src/store');

const EXIT_CODES = { TAMPER: 2, NO_CERT: 3, NOT_FOUND: 4 };

const USAGE = [
  'usage:',
  '  evidence put    --db DIR --id ID --submitter NAME (--data STR | --file PATH) [--timestamp MS]',
  '  evidence get    --db DIR --id ID',
  '  evidence list   --db DIR [--submitter NAME] [--from MS] [--to MS]',
  '  evidence verify --db DIR',
  '  evidence cert   --db DIR --batch BATCH_ID [--out PATH]',
  '',
].join('\n');

// Run one CLI invocation. `io` provides stdout/stderr writers so the CLI can
// be driven in-process from tests. Returns the process exit code.
function run(argv, io) {
  const out = io && io.stdout ? io.stdout : (s) => process.stdout.write(s);
  const err = io && io.stderr ? io.stderr : (s) => process.stderr.write(s);

  try {
    const [cmd, ...rest] = argv;
    if (!cmd) {
      err(USAGE);
      return 1;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        db: { type: 'string' },
        id: { type: 'string' },
        submitter: { type: 'string' },
        data: { type: 'string' },
        file: { type: 'string' },
        timestamp: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        batch: { type: 'string' },
        out: { type: 'string' },
      },
    });

    if (!values.db) {
      err(USAGE);
      return 1;
    }
    const store = new EvidenceStore(values.db);

    switch (cmd) {
      case 'put': {
        if (!values.id || !values.submitter || (values.data === undefined && !values.file)) {
          err(USAGE);
          return 1;
        }
        const payload = values.file ? fs.readFileSync(values.file, 'utf8') : values.data;
        const timestamp = values.timestamp !== undefined ? Number(values.timestamp) : Date.now();
        const cert = store.commit([
          { id: values.id, submitter: values.submitter, timestamp, payload },
        ]);
        out(JSON.stringify(cert, null, 2) + '\n');
        return 0;
      }
      case 'get': {
        if (!values.id) {
          err(USAGE);
          return 1;
        }
        const rec = store.get(values.id);
        if (!rec) {
          err(`NOT_FOUND: no record with id ${values.id}\n`);
          return EXIT_CODES.NOT_FOUND;
        }
        out(JSON.stringify(rec, null, 2) + '\n');
        return 0;
      }
      case 'list': {
        const filter = {};
        if (values.submitter !== undefined) filter.submitter = values.submitter;
        if (values.from !== undefined) filter.from = Number(values.from);
        if (values.to !== undefined) filter.to = Number(values.to);
        out(JSON.stringify(store.list(filter), null, 2) + '\n');
        return 0;
      }
      case 'verify': {
        out(JSON.stringify(store.verify(), null, 2) + '\n');
        return 0;
      }
      case 'cert': {
        if (!values.batch) {
          err(USAGE);
          return 1;
        }
        const text = JSON.stringify(store.cert(values.batch), null, 2) + '\n';
        if (values.out) {
          fs.writeFileSync(values.out, text);
        } else {
          out(text);
        }
        return 0;
      }
      default:
        err(USAGE);
        return 1;
    }
  } catch (e) {
    if (e instanceof StoreError) {
      err(`${e.code}: ${e.message}\n`);
      return EXIT_CODES[e.code] ?? 1;
    }
    err(`ERROR: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, EXIT_CODES };
