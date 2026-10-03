import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { QmsStore } from './store.js';
import { BusinessError, CorruptionError } from './errors.js';

const USAGE = `qms - offline quality judgment store

usage: node bin/qms.js <command> [options]

commands:
  init     --dir DIR                                  create store + default catalog
  report   --dir DIR (--json JSON | --file PATH)      report a measurement
           payload: {clientRecordId, lotId, testCode, value, measuredAt?}
  correct  --dir DIR (--json JSON | --file PATH)      correct an existing record
           payload: {clientRecordId, correctsRecordId, value, measuredAt?}
  status   --dir DIR --lot LOT --test CODE            latest judgment for (lot, test)
  record   --dir DIR --id RECORD_ID                   show one record + certificate
  certs    --dir DIR                                  list all certificates
  verify   --dir DIR [--id RECORD_ID]                 verify hash chain (or one certificate)
  catalog  --dir DIR                                  show test item catalog

exit codes: 0 ok, 1 business error, 2 corruption
`;

function readPayload(args) {
  if (args.json !== undefined) {
    return JSON.parse(args.json);
  }
  if (args.file !== undefined) {
    return JSON.parse(fs.readFileSync(args.file, 'utf8'));
  }
  throw new BusinessError('INVALID_INPUT', 'provide --json or --file');
}

function dispatch(argv) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help') {
    return { usage: true };
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      dir: { type: 'string' },
      json: { type: 'string' },
      file: { type: 'string' },
      lot: { type: 'string' },
      test: { type: 'string' },
      id: { type: 'string' }
    }
  });

  const dir = values.dir;
  if (!dir) {
    throw new BusinessError('INVALID_INPUT', '--dir is required');
  }

  switch (command) {
    case 'init': {
      const store = QmsStore.init(dir);
      return { ok: true, dir, tests: Object.keys(store.catalog) };
    }
    case 'report': {
      const store = QmsStore.open(dir);
      return { ok: true, ...store.report(readPayload(values)) };
    }
    case 'correct': {
      const store = QmsStore.open(dir);
      return { ok: true, ...store.correct(readPayload(values)) };
    }
    case 'status': {
      const store = QmsStore.open(dir);
      if (!values.lot || !values.test) {
        throw new BusinessError('INVALID_INPUT', 'status requires --lot and --test');
      }
      return { ok: true, ...store.status(values.lot, values.test) };
    }
    case 'record': {
      const store = QmsStore.open(dir);
      if (!values.id) {
        throw new BusinessError('INVALID_INPUT', 'record requires --id');
      }
      return { ok: true, ...store.getRecord(values.id) };
    }
    case 'certs': {
      const store = QmsStore.open(dir);
      return { ok: true, certificates: store.certificates() };
    }
    case 'verify': {
      const store = QmsStore.open(dir);
      return store.verify(values.id ?? null);
    }
    case 'catalog': {
      const store = QmsStore.open(dir);
      return { ok: true, catalog: store.catalog };
    }
    default:
      throw new BusinessError('INVALID_INPUT', `unknown command: ${command}`);
  }
}

export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    const result = dispatch(argv);
    if (result.usage) {
      io.stdout(USAGE);
    } else {
      io.stdout(JSON.stringify(result, null, 2) + '\n');
    }
    return 0;
  } catch (err) {
    const code = err instanceof CorruptionError ? err.code
      : err instanceof BusinessError ? err.code
      : 'INTERNAL';
    io.stderr(JSON.stringify({ ok: false, error: { code, message: String(err?.message ?? err) } }) + '\n');
    return err instanceof CorruptionError ? 2 : 1;
  }
}
