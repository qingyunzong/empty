#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ledger } from './src/ledger.js';
import { formatQuantity } from './src/format.js';
import { TraceError } from './src/errors.js';

const USAGE = `usage: node cli.js [--state FILE] <command> ...

commands:
  create <id> <qty>                      create a batch with an exact quantity (e.g. 8, 3/4, 0.5)
  split <id> <child=ratio>...            split a batch; ratios must sum to exactly 1
  join <output> <in1,in2,...> <loss>     join inputs into output with a rational loss rate in [0,1)
  quarantine <id>                        quarantine a batch
  exec <ops.json>                        run several ops inside one transaction (all-or-nothing)
  undo | redo                            undo / redo the last committed transaction
  show <id> [--decimals N]               show quantity: decimal + exact fraction + error bound
  inventory                              list all batches
  ancestors <id> | descendants <id>      genealogy queries
  ratio <from> <to>                      enumerate paths and cumulative rational ratios
  contaminates <qid> <output>            boolean contamination check
  contamination <output>                 contamination certificates for an output`;

function applyOp(tx, op) {
  switch (op.op) {
    case 'create': return tx.create(op.id, op.quantity);
    case 'split': {
      const ids = Array.isArray(op.children) ? op.children : Object.keys(op.children);
      const ratios = Array.isArray(op.children) ? op.ratios : Object.values(op.children);
      return tx.split(op.id, ratios, ids);
    }
    case 'join': return tx.join(op.inputs, op.output, op.loss);
    case 'quarantine': return tx.quarantine(op.id);
    default: throw new TraceError('E_ARG', `unknown op: ${op.op}`);
  }
}

// Programmatic entry point. Returns an exit code; writes through `io`.
export function main(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  let statePath = process.env.TRACE_STATE || 'trace-state.json';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') statePath = argv[++i];
    else if (argv[i].startsWith('--state=')) statePath = argv[i].slice('--state='.length);
    else rest.push(argv[i]);
  }
  const [cmd, ...args] = rest;

  const load = () => (existsSync(statePath) ? Ledger.fromJSON(JSON.parse(readFileSync(statePath, 'utf8'))) : new Ledger());
  const save = (ledger) => writeFileSync(statePath, JSON.stringify(ledger.toJSON(), null, 2));
  const out = (obj) => io.stdout(JSON.stringify(obj, null, 2) + '\n');

  try {
    const ledger = load();
    switch (cmd) {
      case 'create': {
        const [id, qty] = args;
        ledger.create(id, qty);
        save(ledger);
        out({ created: id, quantity: ledger.getBatch(id).quantity });
        return 0;
      }
      case 'split': {
        const [id, ...pairs] = args;
        const childIds = [];
        const ratios = [];
        for (const p of pairs) {
          const eq = p.indexOf('=');
          if (eq < 0) throw new TraceError('E_ARG', `expected child=ratio, got "${p}"`);
          childIds.push(p.slice(0, eq));
          ratios.push(p.slice(eq + 1));
        }
        ledger.split(id, ratios, childIds);
        save(ledger);
        out({ split: id, children: childIds });
        return 0;
      }
      case 'join': {
        const [output, inputsCsv, loss] = args;
        ledger.join(inputsCsv.split(','), output, loss);
        save(ledger);
        out({ joined: inputsCsv.split(','), output, quantity: ledger.getBatch(output).quantity });
        return 0;
      }
      case 'quarantine': {
        ledger.quarantine(args[0]);
        save(ledger);
        out({ quarantined: args[0] });
        return 0;
      }
      case 'exec': {
        const ops = JSON.parse(readFileSync(args[0], 'utf8'));
        const tx = ledger.begin();
        for (const op of ops) applyOp(tx, op);
        tx.commit();
        save(ledger);
        out({ committed: ops.length });
        return 0;
      }
      case 'undo': {
        const did = ledger.undo();
        save(ledger);
        out({ undone: did });
        return 0;
      }
      case 'redo': {
        const did = ledger.redo();
        save(ledger);
        out({ redone: did });
        return 0;
      }
      case 'show': {
        const id = args[0];
        let decimals = 2;
        const di = args.indexOf('--decimals');
        if (di >= 0) decimals = Number(args[di + 1]);
        const b = ledger.getBatch(id);
        out({ id, quarantined: b.quarantined, ...formatQuantity(b.quantity, decimals) });
        return 0;
      }
      case 'inventory':
        out(ledger.inventory());
        return 0;
      case 'ancestors':
        out(ledger.ancestors(args[0]));
        return 0;
      case 'descendants':
        out(ledger.descendants(args[0]));
        return 0;
      case 'ratio':
        out(ledger.pathRatios(args[0], args[1]));
        return 0;
      case 'contaminates':
        out({ quarantined: args[0], output: args[1], contaminates: ledger.contaminates(args[0], args[1]) });
        return 0;
      case 'contamination':
        out(ledger.contamination(args[0]));
        return 0;
      default:
        io.stderr(USAGE + '\n');
        return cmd ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof TraceError) {
      io.stderr(`error ${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
