#!/usr/bin/env node
'use strict';

const { SettlementSystem } = require('./system');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(a);
  }
  return args;
}

const USAGE = `usage: node src/cli.js --data DIR <command> [options]
commands:
  add     --id ID --buyer P --seller P --amount N --desc TEXT
  revoke  --id ID
  delete  --id ID
  net     --a PARTY --b PARTY
  phrase  --q "phrase text"
  near    --x TERM --y TERM [--k N]
  compact
  stats
  hash`;

// In-process entry: returns {code, stdout, stderr} so it is testable
// without spawning a child process.
function run(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || !args.data) {
    return { code: 2, stdout: '', stderr: USAGE + '\n' };
  }
  const sys = new SettlementSystem(args.data, {
    compactThreshold: args.threshold !== undefined ? Number(args.threshold) : undefined,
    marginRate: args.marginRate !== undefined ? Number(args.marginRate) : undefined,
  });
  let result;
  switch (cmd) {
    case 'add':
      result = sys.addTrade({
        id: args.id,
        buyer: args.buyer,
        seller: args.seller,
        amount: Number(args.amount),
        desc: args.desc || '',
      });
      break;
    case 'revoke':
      result = sys.revokeTrade(args.id);
      break;
    case 'delete':
      result = sys.deleteTrade(args.id);
      break;
    case 'net':
      result = sys.getNet(args.a, args.b);
      break;
    case 'phrase':
      result = sys.phrase(args.q || '');
      break;
    case 'near':
      result = sys.near(args.x, args.y, args.k !== undefined ? Number(args.k) : 5);
      break;
    case 'compact':
      result = sys.compact();
      break;
    case 'stats':
      result = sys.index.stats();
      break;
    case 'hash':
      result = sys.hash();
      break;
    default:
      return { code: 2, stdout: '', stderr: `unknown command: ${cmd}\n${USAGE}\n` };
  }
  return { code: 0, stdout: JSON.stringify(result) + '\n', stderr: '' };
}

function main() {
  let r;
  try {
    r = run(process.argv.slice(2));
  } catch (err) {
    r = {
      code: 1,
      stdout: JSON.stringify({ error: { code: err.code || 'INTERNAL', message: err.message } }) + '\n',
      stderr: '',
    };
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}

if (require.main === module) {
  main();
}

module.exports = { run, parseArgs };
