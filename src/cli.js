'use strict';

const path = require('path');
const ledger = require('./ledger');
const { BusinessError, CorruptError } = require('./errors');

function parseTransfer(spec) {
  const parts = spec.split(':');
  if (parts.length !== 4) {
    throw new BusinessError(`bad transfer spec (want id:from:to:amount): ${spec}`);
  }
  const [id, from, to, amount] = parts;
  return { id, from, to, amount: Number(amount) };
}

function parseBudget(spec) {
  const i = spec.lastIndexOf(':');
  if (i <= 0) throw new BusinessError(`bad budget spec (want participant:amount): ${spec}`);
  return [spec.slice(0, i), Number(spec.slice(i + 1))];
}

function parseArgs(argv) {
  const opts = { transfers: [], budgets: {} };
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') opts.data = argv[++i];
    else if (a === '--batch') opts.batch = argv[++i];
    else if (a === '--parent') opts.parent = argv[++i];
    else if (a === '--transfer') opts.transfers.push(parseTransfer(argv[++i]));
    else if (a === '--budget') {
      const [p, amt] = parseBudget(argv[++i]);
      opts.budgets[p] = amt;
    } else if (!a.startsWith('--') && command === null) {
      command = a;
    } else {
      throw new BusinessError(`unknown argument: ${a}`);
    }
  }
  if (!command) throw new BusinessError('command required');
  return { command, opts };
}

function dataDir(opts) {
  return opts.data || process.env.SETTLE_HOME || path.join(process.cwd(), '.settle');
}

function run(argv) {
  try {
    const { command, opts } = parseArgs(argv);
    const dir = dataDir(opts);
    switch (command) {
      case 'propose': {
        const p = ledger.propose(dir, {
          batchId: opts.batch,
          transfers: opts.transfers,
          budgets: opts.budgets,
        });
        console.log(`PROPOSED batch=${p.batchId} transfers=${p.transfers.length}`);
        return 0;
      }
      case 'finalize': {
        const c = ledger.finalize(dir, { batchId: opts.batch, parentBatchId: opts.parent });
        console.log(
          `FINALIZED batch=${c.batchId} level=${c.level} hash=${c.hash.slice(0, 12)} ` +
          `settled=[${c.transfers.join(',')}]`
        );
        return 0;
      }
      case 'correct': {
        const r = ledger.correct(dir, {
          batchId: opts.batch,
          transfers: opts.transfers,
          budgets: opts.budgets,
        });
        const rb = r.rolledBack.map((d) => d.batchId).join(',');
        console.log(
          `CORRECTED batch=${r.chunk.batchId} level=${r.chunk.level} ` +
          `hash=${r.chunk.hash.slice(0, 12)} settled=[${r.chunk.transfers.join(',')}] ` +
          `rolledBack=[${rb}]`
        );
        return 0;
      }
      case 'rollback': {
        const r = ledger.rollback(dir, { batchId: opts.batch });
        const rb = r.rolledBack.map((d) => d.batchId).join(',');
        console.log(`ROLLEDBACK batch=${r.target.batchId} descendants=[${rb}]`);
        return 0;
      }
      case 'verify': {
        const r = ledger.verify(dir);
        for (const line of r.lines) console.log(line);
        return r.code;
      }
      case 'state': {
        const r = ledger.stateReport(dir);
        for (const line of r.lines) console.log(line);
        return 0;
      }
      default:
        throw new BusinessError(`unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof BusinessError) {
      console.error(`CONFLICT ${e.message}`);
      return 1;
    }
    if (e instanceof CorruptError) {
      console.error(`CORRUPT ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { run };
