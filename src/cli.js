// CLI core, separated from process I/O so it can be tested in-process.
// Returns { code, stdout, stderr } instead of touching process directly.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EvidenceStore, StoreError } from './store.js';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadStore(dbPath) {
  if (dbPath && existsSync(dbPath)) {
    return EvidenceStore.fromJSON(JSON.parse(readFileSync(dbPath, 'utf8')));
  }
  return new EvidenceStore();
}

function saveStore(dbPath, store) {
  if (!dbPath) throw new Error('--db is required for mutations');
  writeFileSync(dbPath, JSON.stringify(store.toJSON(), null, 2) + '\n');
}

function buildQuery(args) {
  if (args.phrase !== undefined) return { phrase: String(args.phrase) };
  if (args.near !== undefined) {
    return { near: String(args.near), slop: args.slop !== undefined ? Number(args.slop) : 0 };
  }
  throw new Error('query requires --phrase or --near');
}

export function runCli(argv) {
  try {
    const args = parseArgs(argv);
    const command = args._[0];
    const store = loadStore(args.db);
    let mutated = false;
    let out;

    switch (command) {
      case 'add':
        out = store.addEvidence({
          id: args.id,
          caseId: args.case,
          amount: Number(args.amount),
          text: String(args.text ?? ''),
        });
        mutated = true;
        break;
      case 'correct':
        out = store.correctEvidence(args.id, {
          amount: args.amount !== undefined ? Number(args.amount) : undefined,
          text: args.text !== undefined ? String(args.text) : undefined,
          revision: args.revision !== undefined ? Number(args.revision) : undefined,
        });
        mutated = true;
        break;
      case 'revoke':
        out = store.revokeRevision(args.id, Number(args.revision));
        mutated = true;
        break;
      case 'query': {
        const query = buildQuery(args);
        out =
          args['at-revision'] !== undefined
            ? store.queryAtRevision(args.case, Number(args['at-revision']), query)
            : store.queryCurrent(args.case, query);
        break;
      }
      case 'certificate':
        out = store.getCertificate(args.case, buildQuery(args));
        break;
      case 'amount':
        out = {
          caseId: args.case,
          currentAmount: store.currentAmount(args.case),
          reversalAmount: store.reversalAmount(args.case),
        };
        break;
      default:
        throw new Error(`unknown command: ${command ?? '(none)'}`);
    }

    if (mutated) saveStore(args.db, store);
    return { code: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const code = err instanceof StoreError ? err.code : 'ERROR';
    return { code: 1, stdout: '', stderr: JSON.stringify({ error: code, message: err.message }) + '\n' };
  }
}
