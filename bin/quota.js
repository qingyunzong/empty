#!/usr/bin/env node
import { Store, QuotaError } from '../src/store.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const USAGE = `Usage: quota <command> [options]

Commands:
  freeze   --id ID [--parent ID] --amount N --quota N [--policy TEXT] [--dir DIR]
  expire   --id ID --version N [--dir DIR]
  restore  --id ID --version N [--dir DIR]
  update   --id ID --version N [--amount N] [--policy TEXT] [--dir DIR]
  purge    [--dir DIR]
  query    --phrase TEXT [--dir DIR]
  get      --id ID [--dir DIR]
  balance  --id ID [--dir DIR]
  list     [--dir DIR]

All output is JSON on stdout; errors go to stderr with exit code 1.`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  const dir = args.dir ?? '.quota-data';
  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }
  const store = new Store(dir);
  const num = (v) => (v === undefined ? undefined : Number(v));
  let out;
  switch (command) {
    case 'freeze':
      out = store.freeze({
        id: args.id,
        parentId: args.parent ?? null,
        amount: num(args.amount),
        quota: num(args.quota),
        policyText: args.policy ?? '',
      });
      break;
    case 'expire':
      out = store.expire(args.id, num(args.version));
      break;
    case 'restore':
      out = store.restore(args.id, num(args.version));
      break;
    case 'update':
      out = store.update(args.id, num(args.version), {
        amount: num(args.amount),
        policyText: args.policy,
      });
      break;
    case 'purge':
      out = store.purge();
      break;
    case 'query':
      out = { phrase: args.phrase ?? '', matches: store.query(args.phrase ?? '') };
      break;
    case 'get':
      out = store.get(args.id);
      break;
    case 'balance':
      out = store.balance(args.id);
      break;
    case 'list':
      out = store.list();
      break;
    default:
      console.error(`unknown command: ${command}\n${USAGE}`);
      process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
}

try {
  main();
} catch (err) {
  if (err instanceof QuotaError) {
    console.error(JSON.stringify({ error: err.code, message: err.message }));
  } else {
    console.error(err.stack || String(err));
  }
  process.exit(1);
}
