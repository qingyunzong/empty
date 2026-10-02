#!/usr/bin/env node
'use strict';

const path = require('node:path');
const engine = require('./src/engine');
const chain = require('./src/chain');
const store = require('./src/store');

const USAGE = `usage: budget <command> [args] [--dir <path>]

commands:
  account <id> <budget>     create an account (idempotent)
  enqueue <account> <payment> <amount>
                            queue a payment (idempotent per payment id)
  freeze <payment>          freeze budget for a queued payment
  cancel <payment>          cancel a queued/frozen payment, releasing its freeze
  settle                    select the max settleable set and append a batch block
  refund <payment>          reverse a settled payment, restoring its budget
  batch                     list indexed batches
  batch <n>                 decode batch n via the index
  batch next                incrementally decode the batch after the last indexed one
  verify                    verify log, hash chain and index consistency
  recover                   admit valid unindexed batches; keep corrupt tail unavailable
  status                    dump current state

exit codes: 0 success, 1 business/chain failure, 2 usage error
`;

function parsePositiveInt(text, what, { allowZero = false } = {}) {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw new engine.UsageError(`invalid ${what}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || (!allowZero && value <= 0)) {
    throw new engine.UsageError(`invalid ${what}: ${text}`);
  }
  return value;
}

function need(args, count, command) {
  if (args.length !== count) {
    throw new engine.UsageError(`wrong number of arguments for ${command}`);
  }
}

function run(argv) {
  let dir = process.env.BUDGET_DIR || '.budget';
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') {
      if (i + 1 >= argv.length) throw new engine.UsageError('--dir requires a path');
      dir = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  dir = path.resolve(dir);

  const [command, ...args] = positional;
  switch (command) {
    case 'account': {
      need(args, 2, command);
      const budget = parsePositiveInt(args[1], 'budget', { allowZero: true });
      const { created } = engine.createAccount(dir, args[0], budget);
      console.log(created ? `account ${args[0]} created with budget ${budget}` : `account ${args[0]} unchanged`);
      return 0;
    }
    case 'enqueue': {
      need(args, 3, command);
      const amount = parsePositiveInt(args[2], 'amount');
      const { enqueued } = engine.enqueue(dir, args[0], args[1], amount);
      console.log(enqueued ? `payment ${args[1]} enqueued` : `payment ${args[1]} already enqueued`);
      return 0;
    }
    case 'freeze': {
      need(args, 1, command);
      const { changed } = engine.freeze(dir, args[0]);
      console.log(changed ? `payment ${args[0]} frozen` : `payment ${args[0]} already frozen`);
      return 0;
    }
    case 'cancel': {
      need(args, 1, command);
      const { changed } = engine.cancel(dir, args[0]);
      console.log(changed ? `payment ${args[0]} cancelled` : `payment ${args[0]} already cancelled`);
      return 0;
    }
    case 'settle': {
      need(args, 0, command);
      const { batch } = engine.settle(dir);
      if (!batch) {
        console.log('nothing to settle');
        return 0;
      }
      console.log(`batch ${batch.seq} settled ${batch.selected.length} payment(s), rejected ${batch.rejected.length}`);
      console.log(`hash ${batch.hash}`);
      return 0;
    }
    case 'refund': {
      need(args, 1, command);
      const { batch } = engine.refund(dir, args[0]);
      console.log(`batch ${batch.seq} refunded payment ${args[0]}`);
      console.log(`hash ${batch.hash}`);
      return 0;
    }
    case 'batch': {
      if (args.length === 0) {
        for (const entry of chain.readIndex(dir)) {
          console.log(`${entry.seq}\toffset=${entry.offset}\tlen=${entry.length}\t${entry.hash}`);
        }
        return 0;
      }
      need(args, 1, command);
      if (args[0] === 'next') {
        const lastIndexed = chain.readIndex(dir).length;
        const { batch, error } = chain.decodeNext(dir, lastIndexed);
        if (!batch) {
          if (error) throw new engine.FailError(`chain corrupt after batch ${lastIndexed}: ${error}`);
          console.log('no further batch');
          return 0;
        }
        console.log(JSON.stringify(batch.body, null, 2));
        return 0;
      }
      const seq = parsePositiveInt(args[0], 'batch number');
      try {
        const decoded = chain.readBatch(dir, seq);
        console.log(JSON.stringify(decoded.body, null, 2));
        return 0;
      } catch (err) {
        throw new engine.FailError(err.message);
      }
    }
    case 'verify': {
      need(args, 0, command);
      const result = chain.verifyChain(dir);
      if (!result.ok) {
        for (const error of result.errors) console.error(`verify: ${error}`);
        return 1;
      }
      console.log(`chain ok: ${result.batches.length} batch(es)`);
      return 0;
    }
    case 'recover': {
      need(args, 0, command);
      const result = chain.recoverChain(dir);
      if (result.admitted.length > 0) {
        console.log(`admitted batch(es): ${result.admitted.join(', ')}`);
      } else {
        console.log('nothing to admit');
      }
      if (result.corrupt) {
        console.error(`recover: corrupt tail detected${result.error ? ` (${result.error})` : ''}; valid prefix of ${result.validBatches} batch(es) kept`);
        return 1;
      }
      console.log(`chain ok: ${result.indexed} batch(es) indexed`);
      return 0;
    }
    case 'status': {
      need(args, 0, command);
      console.log(JSON.stringify(store.loadState(dir), null, 2));
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      process.stderr.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

let code;
try {
  code = run(process.argv.slice(2));
} catch (err) {
  if (err instanceof engine.UsageError) {
    console.error(`error: ${err.message}`);
    code = 2;
  } else if (err instanceof engine.FailError) {
    console.error(`error: ${err.message}`);
    code = 1;
  } else {
    console.error(err && err.stack ? err.stack : String(err));
    code = 1;
  }
}
process.exitCode = code;
