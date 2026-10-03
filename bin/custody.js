#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Chain } from '../lib/chain.js';
import { merkleProof, verifyProof } from '../lib/merkle.js';
import { snapshot } from '../lib/snapshot.js';

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

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(err) {
  const code = err.code ?? 'ERROR';
  process.stderr.write(JSON.stringify({ error: code, message: err.message, details: err.details ?? {} }) + '\n');
  process.exitCode = 1;
}

const USAGE = `custody - append-only biological sample custody chain

usage: custody <command> [options]

commands:
  event <type>     append event (receive|transfer|analyze|destroy)
                   options: --sample <id> --consent <id> --data <json>
  revoke           tombstone a consent (old events stay, marked restricted)
                   options: --consent <id> --reason <text>
  challenge        Merkle inclusion proof for a random (or given) leaf
                   options: [--index <n>]
  verify           verify chain integrity, or a proof offline with --proof
                   options: [--proof <file>]
  snapshot         write crash-safe manifest (head + merkle root)
  list             list events with restricted flags

global options:
  --dir <path>     data directory (default: ./custody-data)

error codes: BROKEN_CHAIN, REVOKED_CONSENT, NO_PROOF
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  args._ = args._.slice(1);
  const dir = args.dir ?? './custody-data';

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case 'event': {
      const type = args._[0];
      if (!type) throw new Error('event type required: receive|transfer|analyze|destroy');
      const chain = await Chain.open(dir);
      const event = await chain.append({
        type,
        sampleId: args.sample ?? null,
        consentId: args.consent ?? null,
        data: args.data ? JSON.parse(args.data) : {},
      });
      out({ appended: event, head: chain.head });
      break;
    }
    case 'revoke': {
      if (!args.consent) throw new Error('--consent <id> required');
      const chain = await Chain.open(dir);
      const event = await chain.append({
        type: 'revoke',
        consentId: args.consent,
        data: { reason: args.reason ?? null },
      });
      out({ revoked: args.consent, tombstone: event, head: chain.head });
      break;
    }
    case 'challenge': {
      const chain = await Chain.open(dir);
      const leaves = chain.leafHashes();
      const index = args.index !== undefined ? Number(args.index) : Math.floor(Math.random() * leaves.length);
      out(merkleProof(leaves, index));
      break;
    }
    case 'verify': {
      if (args.proof) {
        const proof = JSON.parse(await readFile(args.proof, 'utf8'));
        const ok = verifyProof(proof);
        out({ proofValid: ok, root: proof.root ?? null });
        if (!ok) process.exitCode = 1;
      } else {
        const chain = await Chain.open(dir);
        chain.verify();
        out({ chainValid: true, head: chain.head, merkleRoot: chain.merkleRoot, eventCount: chain.events.length });
      }
      break;
    }
    case 'snapshot': {
      const chain = await Chain.open(dir);
      out(await snapshot(chain));
      break;
    }
    case 'list': {
      const chain = await Chain.open(dir);
      out(chain.list());
      break;
    }
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch(fail);
