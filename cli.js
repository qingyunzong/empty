#!/usr/bin/env node
'use strict';

const {
  ArchiveError,
  createArchive,
  inspectArchive,
  verifyArchive,
  planRepair,
  applyPlan,
} = require('./lib/archive');

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(err) {
  const code = err instanceof ArchiveError ? err.code : 'ERR_IO';
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n');
  process.exit(2);
}

function usage() {
  fail(
    new ArchiveError(
      'ERR_USAGE',
      'usage: node cli.js inspect <arc> | verify <arc> | ' +
        'planRepair <arc> <knownGoodDir> <maxBytes> | applyPlan <arc> <plan.json> | ' +
        'create <dir> <blockSize>  (archive bytes on stdin)'
    )
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'inspect': {
      if (args.length !== 1) usage();
      print(inspectArchive(args[0]));
      break;
    }
    case 'verify': {
      if (args.length !== 1) usage();
      const result = verifyArchive(args[0]);
      print(result);
      if (!result.ok) process.exit(1);
      break;
    }
    case 'planRepair': {
      if (args.length !== 3) usage();
      print(planRepair(args[0], args[1], Number(args[2])));
      break;
    }
    case 'applyPlan': {
      if (args.length !== 2) usage();
      print(applyPlan(args[0], args[1]));
      break;
    }
    case 'create': {
      if (args.length !== 2) usage();
      const blockSize = Number(args[1]);
      if (!Number.isInteger(blockSize) || blockSize <= 0) {
        throw new ArchiveError('ERR_BUDGET', `blockSize must be a positive integer, got: ${args[1]}`);
      }
      const input = await readStdin();
      const chunks = [];
      for (let off = 0; off < input.length; off += blockSize) {
        chunks.push(input.subarray(off, Math.min(off + blockSize, input.length)));
      }
      const manifest = createArchive(args[0], chunks);
      print({ created: args[0], blocks: manifest.blocks.length });
      break;
    }
    default:
      usage();
  }
}

main().catch(fail);
