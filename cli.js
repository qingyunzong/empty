#!/usr/bin/env node
import { BondTree } from './src/bondtree.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

const USAGE = `Usage: node cli.js <command> --data <dir> [options]

Commands:
  add      --id N --parent P --face V --limit L --terms "text"
  revoke   --id N
  delete   --id N
  phrase   --q "some phrase"
  near     --q "term1 term2" [--k 5]
  show     [--id N]        node info / occupancy; without --id lists all
  certs                  list revocation certificates and root cert hash
`;

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help) {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 1);
  }
  const dir = flags.data ?? './bond-data';
  const tree = new BondTree(dir);
  let out;
  switch (command) {
    case 'add':
      out = tree.addNode({
        id: flags.id,
        parentId: flags.parent ?? null,
        faceValue: Number(flags.face ?? 0),
        lineLimit: Number(flags.limit ?? 0),
        terms: flags.terms ?? '',
      });
      break;
    case 'revoke':
      out = tree.revokeNode(flags.id);
      break;
    case 'delete':
      out = tree.deleteNode(flags.id);
      break;
    case 'phrase':
      out = tree.phrase(flags.q ?? '');
      break;
    case 'near':
      out = tree.near(flags.q ?? '', Number(flags.k ?? 5));
      break;
    case 'show':
      out = flags.id
        ? { ...tree.getNode(flags.id), postOrderOccupancy: tree.postOrderOccupancy(flags.id) }
        : [...tree.nodes.values()];
      break;
    case 'certs':
      out = { rootCertHash: tree.certTip, chainValid: tree.verifyCertChain(), certs: tree.certs };
      break;
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      process.exit(1);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
