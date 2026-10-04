#!/usr/bin/env node
import { writeSync } from 'node:fs';
import { PaymentService, CrashSimulated } from './payments.js';

const USAGE = `Usage: payctl --db <dir> <command> [options]

Commands:
  pay     --request-id <id> --account <name> --amount <n> [--crash-at P1|P2]
  cancel  --request-id <id> --tx <txId> [--crash-at P1|P2]
  retry   --request-id <id> [--crash-at P1|P2]
  get     --tx <txId> | --account <name> | --request-id <id>

Exit codes: 0 ok, 1 error result (E_*), 2 simulated crash (no response).`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function fail(message) {
  writeSync(2, `${message}\n\n${USAGE}\n`);
  process.exit(64);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const db = args.db ?? './paydb';
  const crashAt = args['crash-at'] ?? null;

  const service = new PaymentService(db, { crashAt });
  let result;
  try {
    if (command === 'pay') {
      if (!args['request-id'] || !args.account || args.amount === undefined) {
        fail('pay requires --request-id, --account, --amount');
      }
      result = service.pay({
        requestId: args['request-id'],
        account: args.account,
        amount: Number(args.amount),
      });
    } else if (command === 'cancel') {
      if (!args['request-id'] || !args.tx) fail('cancel requires --request-id, --tx');
      result = service.cancel({ requestId: args['request-id'], txId: args.tx });
    } else if (command === 'retry') {
      if (!args['request-id']) fail('retry requires --request-id');
      result = service.retry({ requestId: args['request-id'] });
    } else if (command === 'get') {
      if (args.tx) result = service.getTransaction(args.tx);
      else if (args.account) result = service.getBalance(args.account);
      else if (args['request-id']) result = service.getResultByRequestId(args['request-id']);
      else fail('get requires --tx, --account or --request-id');
    } else {
      fail(`unknown command: ${command ?? '(none)'}`);
    }
  } catch (err) {
    if (err instanceof CrashSimulated) process.exit(2); // crash: no response
    throw err;
  }

  writeSync(1, `${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

main();
