#!/usr/bin/env node
import { BondTree } from './tree.js';

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

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const [cmd] = args._;
const tree = new BondTree(args.data ?? 'bond-data.json');

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
};

switch (cmd) {
  case 'add':
    out(tree.addNode({
      id: args.id,
      parentId: args.parent ?? null,
      faceValue: num(args.face ?? 0, 'face'),
      lineLimit: num(args.limit ?? 0, 'limit'),
      terms: args.terms ?? '',
    }));
    break;
  case 'allocate':
    out(tree.allocate(args.id, num(args.amount, 'amount')));
    break;
  case 'revoke':
    if (args.near) out(tree.revokeByNear(args.near, num(args.k ?? 5, 'k'), num(args.amount, 'amount')));
    else out(tree.revoke(args.id, num(args.amount, 'amount')));
    break;
  case 'delete':
    out(tree.deleteNode(args.id));
    break;
  case 'search':
    if (args.near) out(Object.fromEntries(tree.findNear(args.near, num(args.k ?? 5, 'k'))));
    else out(Object.fromEntries(tree.findByPhrase(args.phrase ?? '')));
    break;
  case 'show':
    out(args.id ? tree.getNode(args.id) : tree.listNodes());
    break;
  case 'roothash':
    out({ rootCertHash: tree.rootCertHash() });
    break;
  default:
    process.stderr.write(
      'usage: node src/cli.js [--data FILE] <cmd>\n' +
      '  add --id ID [--parent ID] [--face N] [--limit N] [--terms TEXT]\n' +
      '  allocate --id ID --amount N\n' +
      '  revoke --id ID --amount N | revoke --near "t1 t2" --k K --amount N\n' +
      '  delete --id ID\n' +
      '  search --phrase "..." | search --near "t1 t2" --k K\n' +
      '  show [--id ID] | roothash\n');
    process.exit(cmd ? 1 : 0);
}
