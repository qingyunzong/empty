#!/usr/bin/env node
// CLI over the evidence store. State lives in a JSONL append-only log.
//
//   node src/cli.js --store FILE case:create CASE
//   node src/cli.js --store FILE add CASE ID AMOUNT REVISION TEXT
//   node src/cli.js --store FILE revoke CASE ID REVISION
//   node src/cli.js --store FILE search CASE (--phrase|--near) TERM... [--slop N] [--revision N]
//   node src/cli.js --store FILE cert   CASE (--phrase|--near) TERM... [--slop N] [--revision N]
//   node src/cli.js --store FILE amounts CASE
//
// Exit codes: 0 ok, 1 store/usage error.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  hydrateStore, registerCase, addEvidence, revokeRevision,
  search, caseAmounts, StoreError,
} from './store.js';
import { issueCertificate } from './certificate.js';

const USAGE = 'usage: cli.js --store FILE <case:create|add|revoke|search|cert|amounts> ...';

class UsageError extends Error {}

function parseQueryArgs(args) {
  let type = null;
  const terms = [];
  let slop = 0;
  let revision;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--phrase' || a === '--near') {
      type = a.slice(2);
    } else if (a === '--slop') {
      slop = Number(args[++i]);
    } else if (a === '--revision') {
      revision = Number(args[++i]);
    } else {
      terms.push(a);
    }
  }
  if (!type || terms.length === 0) throw new UsageError(USAGE);
  if (!Number.isInteger(slop) || slop < 0) throw new UsageError('--slop must be a non-negative integer');
  return { query: { type, terms, slop }, opts: revision === undefined ? {} : { revision } };
}

// Runs one CLI command. Returns the exit code. Output goes through `io`
// ({log, error}) so tests can drive it in-process.
export function run(argv, io = { log: console.log, error: console.error }) {
  try {
    const args = [...argv];
    let storePath = process.env.EVIDENCE_STORE || 'evidence-store.jsonl';
    const si = args.indexOf('--store');
    if (si !== -1) {
      storePath = args[si + 1];
      args.splice(si, 2);
    }
    const [cmd, ...rest] = args;
    if (!cmd) throw new UsageError(USAGE);

    const before = existsSync(storePath)
      ? readFileSync(storePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const store = hydrateStore(before);
    const flush = () => {
      const fresh = store.records.slice(before.length);
      if (fresh.length > 0) {
        appendFileSync(storePath, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
      }
    };

    switch (cmd) {
      case 'case:create': {
        if (rest.length !== 1) throw new UsageError('case:create CASE');
        const rec = registerCase(store, rest[0]);
        flush();
        io.log(JSON.stringify(rec));
        return 0;
      }
      case 'add': {
        const [caseId, id, amount, revision, ...textParts] = rest;
        if (!caseId || !id || textParts.length === 0 || !Number.isFinite(Number(amount)) || !Number.isInteger(Number(revision))) {
          throw new UsageError('add CASE ID AMOUNT REVISION TEXT');
        }
        const rec = addEvidence(store, {
          caseId, id, amount: Number(amount), revision: Number(revision), text: textParts.join(' '),
        });
        flush();
        io.log(JSON.stringify(rec));
        return 0;
      }
      case 'revoke': {
        const [caseId, id, revision] = rest;
        if (!caseId || !id || !Number.isInteger(Number(revision))) throw new UsageError('revoke CASE ID REVISION');
        const rec = revokeRevision(store, caseId, id, Number(revision));
        flush();
        io.log(JSON.stringify(rec));
        return 0;
      }
      case 'search': {
        const [caseId, ...q] = rest;
        const { query, opts } = parseQueryArgs(q);
        io.log(JSON.stringify(search(store, caseId, query, opts)));
        return 0;
      }
      case 'cert': {
        const [caseId, ...q] = rest;
        const { query, opts } = parseQueryArgs(q);
        io.log(JSON.stringify(issueCertificate(store, caseId, query, opts)));
        return 0;
      }
      case 'amounts': {
        if (rest.length !== 1) throw new UsageError('amounts CASE');
        io.log(JSON.stringify(caseAmounts(store, rest[0])));
        return 0;
      }
      default:
        throw new UsageError(USAGE);
    }
  } catch (err) {
    if (err instanceof StoreError) {
      io.error(`error ${err.code}: ${err.message}`);
      return 1;
    }
    if (err instanceof UsageError) {
      io.error(`error ERR_USAGE: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
