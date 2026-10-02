#!/usr/bin/env node
import fs from 'node:fs';
import { CustodyChain } from '../src/chain.js';
import { ChainError } from '../src/errors.js';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else opts._.push(a);
  }
  return opts;
}

const USAGE = `custody-chain - append-only chain-of-custody audit log

usage: node bin/cli.js <command> --store DIR [options]

commands:
  event     --type receive|transfer|analyze|destroy --consent ID [--sample ID] [--actor NAME] [--payload JSON]
  revoke    --consent ID --reason TEXT [--actor NAME]
  challenge [--index N]        random leaf index if omitted; prints Merkle proof
  verify    [--proof FILE]     offline chain + manifest check; optionally verifies a proof
  snapshot                     write manifest atomically (tmp+fsync+rename)
  list                         print events with restricted flags
`;

// Runs one CLI invocation. Returns an exit code; output goes to the
// injected writers so tests can capture it in-process.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const out = (obj) => io.stdout(JSON.stringify(obj, null, 2) + '\n');
  try {
    const opts = parseArgs(argv);
    const cmd = opts._[0];
    if (!cmd || cmd === 'help') { io.stdout(USAGE); return 0; }
    const dir = opts.store ?? './store';
    const chain = CustodyChain.open(dir);

    switch (cmd) {
      case 'event': {
        const rec = chain.appendEvent({
          type: opts.type,
          actor: opts.actor,
          sampleId: opts.sample ?? null,
          consentId: opts.consent ?? null,
          payload: opts.payload ? JSON.parse(opts.payload) : null,
        });
        out({ appended: rec });
        return 0;
      }
      case 'revoke': {
        const rec = chain.appendEvent({
          type: 'revoke',
          actor: opts.actor,
          consentId: opts.consent ?? null,
          reason: opts.reason ?? null,
        });
        out({ revoked: rec });
        return 0;
      }
      case 'challenge': {
        out(chain.challenge(opts.index !== undefined ? Number(opts.index) : null));
        return 0;
      }
      case 'verify': {
        const result = chain.verify();
        if (opts.proof) {
          const proof = JSON.parse(fs.readFileSync(opts.proof, 'utf8'));
          const valid = CustodyChain.verifyProof(proof) && proof.root === result.merkleRoot;
          result.proof = { index: proof.index, valid };
          if (!valid) {
            throw new ChainError('NO_PROOF', `proof for index ${proof.index} does not verify against chain root`);
          }
        }
        out(result);
        return 0;
      }
      case 'snapshot': {
        out(chain.snapshot());
        return 0;
      }
      case 'list': {
        const restricted = new Set(chain.restrictedSeqs());
        out(chain.events.map((e) => ({ ...e, restricted: restricted.has(e.seq) })));
        return 0;
      }
      default:
        throw new ChainError('INVALID_EVENT', `unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof ChainError) {
      io.stderr(`ERROR ${err.code}: ${err.message}\n`);
      if (err.details) io.stderr(JSON.stringify(err.details) + '\n');
      return 1;
    }
    io.stderr(`ERROR INTERNAL: ${err.message}\n`);
    return 2;
  }
}

// Executed directly (not imported): run and set the process exit code.
if (process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href) {
  process.exitCode = run(process.argv.slice(2));
}
