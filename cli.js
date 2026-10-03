#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { PaymentService, DEFAULT_ACCOUNT } from './src/payments.js';

const USAGE = `usage:
  node cli.js pay    --request-id R [--account A] --amount N [--data-dir D] [--crash-at P1|P2]
  node cli.js cancel --request-id R --txn-id T [--data-dir D] [--crash-at P1|P2]
  node cli.js retry  --request-id R [--data-dir D] [--crash-at P1|P2]
  node cli.js get    [--txn-id T | --request-id R | --balance [--account A]] [--data-dir D]`;

class UsageError extends Error {}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'balance') {
      flags.balance = true;
    } else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new UsageError(`missing value for --${key}`);
      }
      flags[key] = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}

// Runs one CLI invocation. Returns the process exit code; emits one JSON
// document on stdout (or stderr for usage errors and simulated crashes).
export function runCli(argv, io = { stdout: console.log, stderr: console.error }) {
  let flags;
  try {
    flags = parseFlags(argv.slice(1));
  } catch (err) {
    io.stderr(`error: ${err.message}\n${USAGE}`);
    return 2;
  }
  const cmd = argv[0];
  const dir = flags['data-dir'] ?? './paydb';
  const crashAt = flags['crash-at'];
  if (crashAt !== undefined && crashAt !== 'P1' && crashAt !== 'P2') {
    io.stderr(`error: invalid --crash-at ${crashAt} (expected P1 or P2)\n${USAGE}`);
    return 2;
  }

  const svc = PaymentService.open(dir);
  try {
    let result;
    if (cmd === 'pay') {
      if (!flags['request-id'] || flags.amount === undefined) throw new UsageError('pay requires --request-id and --amount');
      result = svc.pay(
        { requestId: flags['request-id'], account: flags.account ?? DEFAULT_ACCOUNT, amount: Number(flags.amount) },
        { crashAt },
      );
    } else if (cmd === 'cancel') {
      if (!flags['request-id'] || !flags['txn-id']) throw new UsageError('cancel requires --request-id and --txn-id');
      result = svc.cancel({ requestId: flags['request-id'], txnId: flags['txn-id'] }, { crashAt });
    } else if (cmd === 'retry') {
      if (!flags['request-id']) throw new UsageError('retry requires --request-id');
      result = svc.retry({ requestId: flags['request-id'] }, { crashAt });
    } else if (cmd === 'get') {
      if (flags['txn-id']) {
        result = svc.getTransaction(flags['txn-id']);
      } else if (flags['request-id']) {
        result = svc.getRequest(flags['request-id']);
      } else {
        const account = flags.account ?? DEFAULT_ACCOUNT;
        result = { account, balance: svc.getBalance(account) };
      }
    } else {
      throw new UsageError(`unknown command ${cmd ?? '(none)'}`);
    }
    io.stdout(JSON.stringify({ ok: true, result }));
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    if (err.code === 'E_CRASH') {
      io.stderr(JSON.stringify({ ok: false, crashed: true, point: err.point }));
      return 2;
    }
    io.stdout(JSON.stringify({ ok: false, error: { code: err.code ?? 'E_INTERNAL', message: err.message } }));
    return 1;
  } finally {
    svc.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
