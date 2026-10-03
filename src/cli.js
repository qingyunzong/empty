#!/usr/bin/env node
import { Store } from './store.js';
import { QrecError } from './errors.js';
import { fileURLToPath } from 'node:url';

const EXIT_CODES = {
  E_USAGE: 2,
  E_CRC: 3,
  E_REFERENCE: 4,
  E_NOTFOUND: 5,
  E_BATCH: 6,
  E_VALUE: 7,
};

const USAGE = `qrec - offline inspection record store

usage:
  qrec create  <dir> <batch> --baseline N --tolerance N [--time MS]
  qrec add     <dir> <batch> --value N [--time MS]
  qrec correct <dir> <batch> --seq N --value N --reason S [--time MS]
  qrec show    <dir> <batch> [--records K] [--json]
  qrec audit   <dir> <batch> --records K
  qrec locate  <dir> <batch> --time MS
  qrec verify  <dir>
`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

function num(opts, key, { required = true, def = undefined } = {}) {
  const raw = opts[key];
  if (raw === undefined || raw === true) {
    if (required) throw new QrecError('E_USAGE', `missing --${key}`);
    return def;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new QrecError('E_USAGE', `--${key} must be a number, got: ${raw}`);
  return v;
}

function str(opts, key, { required = true, def = undefined } = {}) {
  const raw = opts[key];
  if (raw === undefined || raw === true) {
    if (required) throw new QrecError('E_USAGE', `missing --${key}`);
    return def;
  }
  return String(raw);
}

function printDecoded(out, d) {
  out(`batch: ${d.batchId}`);
  out(`baseline: ${d.baseline}`);
  out(`tolerance: ${d.tolerance}`);
  out(`records: ${d.recordCount}`);
  out('history:');
  for (const h of d.history) {
    if (h.type === 'baseline') {
      out(`  #${h.index} baseline time=${h.time} value=${h.value}`);
    } else if (h.type === 'measurement') {
      const flags = `${h.passes ? 'PASS' : 'FAIL'}${h.superseded ? ' [superseded]' : ''}`;
      out(`  #${h.index} measurement seq=${h.seq} time=${h.time} value=${h.value} ${flags}`);
    } else {
      out(
        `  #${h.index} compensation target=${h.targetSeq} time=${h.time} value=${h.value} reason=${JSON.stringify(h.reason)}`
      );
    }
  }
  out('effective:');
  for (const m of d.effective) {
    const corr = m.corrected ? ` (corrected: ${m.reason})` : '';
    out(`  seq=${m.seq} value=${m.value} ${m.passes ? 'PASS' : 'FAIL'}${corr}`);
  }
  out(`judgment: ${d.judgment.pass ? 'PASS' : 'FAIL'}`);
  if (d.judgment.failures.length > 0) {
    out(`failures: ${d.judgment.failures.join(', ')}`);
  }
}

export function runCli(argv, { out = console.log, err = console.error } = {}) {
  const { pos, opts } = parseArgs(argv);
  const [cmd, dir, batch] = pos;
  try {
    switch (cmd) {
      case 'create': {
        if (!dir || !batch) throw new QrecError('E_USAGE', 'create needs <dir> <batch>');
        const store = Store.open(dir);
        store.createBatch(batch, {
          baseline: num(opts, 'baseline'),
          tolerance: num(opts, 'tolerance'),
          time: num(opts, 'time', { required: false, def: Date.now() }),
        });
        out(`created batch ${batch}`);
        return 0;
      }
      case 'add': {
        if (!dir || !batch) throw new QrecError('E_USAGE', 'add needs <dir> <batch>');
        const store = Store.open(dir);
        const seq = store.append(batch, {
          value: num(opts, 'value'),
          time: num(opts, 'time', { required: false, def: Date.now() }),
        });
        out(`appended measurement seq=${seq}`);
        return 0;
      }
      case 'correct': {
        if (!dir || !batch) throw new QrecError('E_USAGE', 'correct needs <dir> <batch>');
        const store = Store.open(dir);
        store.correct(batch, num(opts, 'seq'), {
          value: num(opts, 'value'),
          reason: str(opts, 'reason', { required: false, def: '' }),
          time: num(opts, 'time', { required: false, def: Date.now() }),
        });
        out(`appended compensation for seq=${num(opts, 'seq')}`);
        return 0;
      }
      case 'show':
      case 'audit': {
        if (!dir || !batch) throw new QrecError('E_USAGE', `${cmd} needs <dir> <batch>`);
        const store = Store.open(dir, { strict: false });
        for (const e of store.errors) {
          err(`warning[${e.code}]: ${e.file}: ${e.message}`);
        }
        const upToRecords =
          cmd === 'audit'
            ? num(opts, 'records')
            : num(opts, 'records', { required: false, def: Number.POSITIVE_INFINITY });
        const d = store.decode(batch, { upToRecords });
        if (opts.json) out(JSON.stringify(d, null, 2));
        else printDecoded(out, d);
        return 0;
      }
      case 'locate': {
        if (!dir || !batch) throw new QrecError('E_USAGE', 'locate needs <dir> <batch>');
        const store = Store.open(dir);
        const rec = store.locate(batch, num(opts, 'time'));
        out(JSON.stringify(rec));
        return 0;
      }
      case 'verify': {
        if (!dir) throw new QrecError('E_USAGE', 'verify needs <dir>');
        const store = Store.open(dir, { strict: false });
        out(`chunks: ${store.manifest.chunks.length} listed`);
        if (store.errors.length === 0) {
          out('verify: OK');
          return 0;
        }
        for (const e of store.errors) {
          err(`error[${e.code}]: ${e.file}: ${e.message}`);
        }
        return EXIT_CODES[store.errors[0].code] ?? 1;
      }
      default:
        err(USAGE);
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : EXIT_CODES.E_USAGE;
    }
  } catch (error) {
    if (error instanceof QrecError) {
      err(`error[${error.code}]: ${error.message}`);
      return EXIT_CODES[error.code] ?? 1;
    }
    err(`error[E_INTERNAL]: ${error.stack || error}`);
    return 1;
  }
}

const invokedAs = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedAs) {
  process.exitCode = runCli(process.argv.slice(2));
}
