#!/usr/bin/env node
import { Ledger } from './src/ledger.js';
import { CrashError } from './src/errors.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseInit(spec) {
  if (!spec || spec === true) return null;
  const out = {};
  for (const pair of spec.split(',')) {
    const [name, value] = pair.split('=');
    out[name] = Number(value);
  }
  return out;
}

const USAGE = `Usage:
  node cli.js --dir D [--init alice=1000,bob=500] submit --key K --op freeze|debit|release --account A --amount N
  node cli.js --dir D submit --key K --op reverse --target TARGET_KEY
  node cli.js --dir D reverse --key K --target TARGET_KEY
  node cli.js --dir D status --key K
  node cli.js --dir D balance --account A
  node cli.js --dir D list
  node cli.js --dir D recover
Fault injection (one-shot simulated crash): --fault-after intent|applied|commit`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || args.help) {
  console.log(USAGE);
  process.exit(cmd ? 0 : 64);
}

const dir = typeof args.dir === 'string' ? args.dir : './ledger-data';
const ledger = new Ledger(dir, {
  faultAfter: typeof args['fault-after'] === 'string' ? args['fault-after'] : null,
  initBalances: parseInit(args.init),
});

try {
  ledger.open();
  let out;
  switch (cmd) {
    case 'submit':
      out = ledger.submit({
        key: args.key,
        op: args.op,
        account: args.account,
        amount: args.amount !== undefined ? Number(args.amount) : undefined,
        target: args.target,
      });
      break;
    case 'reverse':
      out = ledger.submit({ key: args.key, op: 'reverse', target: args.target });
      break;
    case 'status':
      out = ledger.status(args.key);
      break;
    case 'balance':
      out = ledger.balance(args.account);
      break;
    case 'list':
      out = ledger.list();
      break;
    case 'recover':
      out = { recovered: true, txs: ledger.list() };
      break;
    default:
      console.error(USAGE);
      process.exit(64);
  }
  console.log(JSON.stringify(out, null, 2));
  ledger.close();
} catch (err) {
  if (err instanceof CrashError) {
    console.error(JSON.stringify({ crashed: err.point, message: err.message }));
    process.exit(2);
  }
  if (err && err.code) {
    console.error(JSON.stringify({ error: err.code, message: err.message }));
    process.exit(1);
  }
  throw err;
}
