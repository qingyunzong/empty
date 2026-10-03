#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ledger } from './ledger.js';
import { verifyProof } from './certs.js';
import { LineageError, E_INPUT, E_PROOF } from './errors.js';

const USAGE = `batch-lineage <command> [options]
  --db PATH                 event log file (default ./lineage.jsonl)
  add      --id X [--parents A,B] --text "remark" --ts N
  correct  --child C --from A --to B --ts N     reverse-compensating parent fix
  delete   --id X --ts N                        tombstone a batch
  ancestors|descendants --id X [--at N]
  search   (--phrase "a b" | --near "a b" [--dist K]) [--at N]
  cert     --id X [--at N]
  prove    --id X [--version N]                 inclusion proof for a cert
  verify   (--proof JSON | --proof-file PATH)   verify an inclusion proof
  root                                          current Merkle root`;

function parse(argv) {
  const opts = {};
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) {
        opts[k] = nxt;
        i++;
      } else {
        opts[k] = true;
      }
    } else if (cmd === null) {
      cmd = a;
    }
  }
  return { cmd, opts };
}

function num(v, name) {
  const n = Number(v);
  if (v === undefined || v === true || !Number.isFinite(n)) {
    throw new LineageError(E_INPUT, `--${name} must be a number`);
  }
  return n;
}

function str(v, name) {
  if (v === undefined || v === true) {
    throw new LineageError(E_INPUT, `--${name} is required`);
  }
  return String(v);
}

// Runs one CLI invocation. Returns { code, stdout, stderr } so it can be
// driven both from the shell wrapper below and in-process from tests.
export function runCli(argv) {
  const stdout = [];
  const stderr = [];
  const out = (x) => stdout.push(JSON.stringify(x));
  let code = 0;

  try {
    const { cmd, opts } = parse(argv);
    const db = opts.db === undefined || opts.db === true ? 'lineage.jsonl' : String(opts.db);
    const at = opts.at === undefined ? Infinity : num(opts.at, 'at');

    const mutate = (ev) => {
      const ledger = Ledger.load(db);
      ledger.append(ev);
      appendFileSync(db, JSON.stringify(ev) + '\n');
      out({ ok: true, event: ev });
    };

    switch (cmd) {
      case 'add':
        mutate({
          type: 'add',
          id: str(opts.id, 'id'),
          parents: opts.parents ? String(opts.parents).split(',').filter(Boolean) : [],
          text: opts.text === undefined || opts.text === true ? '' : String(opts.text),
          ts: num(opts.ts, 'ts'),
        });
        break;
      case 'correct':
        mutate({
          type: 'correct',
          child: str(opts.child, 'child'),
          from: str(opts.from, 'from'),
          to: str(opts.to, 'to'),
          ts: num(opts.ts, 'ts'),
        });
        break;
      case 'delete':
        mutate({ type: 'delete', id: str(opts.id, 'id'), ts: num(opts.ts, 'ts') });
        break;
      case 'ancestors':
        out(Ledger.load(db).ancestors(str(opts.id, 'id'), at));
        break;
      case 'descendants':
        out(Ledger.load(db).descendants(str(opts.id, 'id'), at));
        break;
      case 'search': {
        const ledger = Ledger.load(db);
        if (opts.phrase !== undefined) out(ledger.searchPhrase(str(opts.phrase, 'phrase'), at));
        else if (opts.near !== undefined) {
          const [a, b] = str(opts.near, 'near').split(/\s+/);
          out(ledger.searchNear(a, b, opts.dist === undefined ? 3 : num(opts.dist, 'dist'), at));
        } else throw new LineageError(E_INPUT, 'search needs --phrase or --near');
        break;
      }
      case 'cert':
        out(Ledger.load(db).cert(str(opts.id, 'id'), at));
        break;
      case 'prove':
        out(
          Ledger.load(db).prove(
            str(opts.id, 'id'),
            opts.version === undefined ? null : num(opts.version, 'version'),
          ),
        );
        break;
      case 'verify': {
        const proof = JSON.parse(
          opts.proof !== undefined
            ? str(opts.proof, 'proof')
            : readFileSync(str(opts['proof-file'], 'proof-file'), 'utf8'),
        );
        if (!verifyProof(proof)) {
          throw new LineageError(E_PROOF, 'inclusion proof does not verify');
        }
        const root = Ledger.load(db).root();
        out({ ok: true, root: proof.root, included: proof.root === root });
        break;
      }
      case 'root':
        out({ root: Ledger.load(db).root() });
        break;
      default:
        stderr.push(USAGE);
        code = cmd ? 1 : 2;
    }
  } catch (e) {
    const ecode = e instanceof LineageError ? e.code : 'E_INTERNAL';
    stderr.push(JSON.stringify({ error: ecode, message: e.message }));
    code = 1;
  }
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  process.exitCode = code;
}
