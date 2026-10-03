#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Ledger, TraceError } = require('./src/ledger');

const STATE_FILE = process.env.TRACE_STATE || path.join(process.cwd(), 'trace-state.json');

function load() {
  if (!fs.existsSync(STATE_FILE)) return new Ledger();
  return Ledger.fromJSON(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
}
function save(ledger) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(ledger.toJSON(), null, 2));
}
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

const USAGE = `batch-trace CLI (state file: $TRACE_STATE or ./trace-state.json)
  create <id> <qty>                      create a root batch
  split <id> <child:ratio>...            split batch; ratios must sum to exactly 1
  join <output> <loss> <input>...        join inputs; output = sum(inputs) * (1 - loss)
  quarantine <id>                        quarantine a batch
  undo | redo                            undo/redo last committed transaction
  inventory                              list live batches
  ancestors <id> | descendants <id>      genealogy queries
  paths <id>                             maximal paths with cumulative exact ratios
  pollutes <quarantinedId> <outputId>    pollution check with certificate
  quantity <id> [decimals]               exact fraction + rounded decimal + error bound`;

function main(argv) {
  const [cmd, ...args] = argv;
  const ledger = load();
  switch (cmd) {
    case 'create': {
      const [id, qty] = args;
      ledger.create(id, qty);
      save(ledger);
      out({ ok: true, op: 'create', id, quantity: ledger.quantity(id).exact });
      return;
    }
    case 'split': {
      const [id, ...pairs] = args;
      const children = pairs.map((p) => {
        const i = p.lastIndexOf(':');
        if (i <= 0) throw new TraceError('E_RATIONAL', `bad child:ratio pair "${p}"`);
        return { id: p.slice(0, i), ratio: p.slice(i + 1) };
      });
      ledger.split(id, children);
      save(ledger);
      out({ ok: true, op: 'split', id, children: children.map((c) => ({ id: c.id, quantity: ledger.quantity(c.id).exact })) });
      return;
    }
    case 'join': {
      const [output, loss, ...inputs] = args;
      ledger.join(inputs, output, loss);
      save(ledger);
      out({ ok: true, op: 'join', output, quantity: ledger.quantity(output).exact });
      return;
    }
    case 'quarantine': {
      ledger.quarantine(args[0]);
      save(ledger);
      out({ ok: true, op: 'quarantine', id: args[0] });
      return;
    }
    case 'undo': case 'redo': {
      const moved = ledger[cmd]();
      save(ledger);
      out({ ok: moved, op: cmd, undoDepth: ledger.undoDepth, redoDepth: ledger.redoDepth });
      return;
    }
    case 'inventory': {
      out(ledger.inventory().map((b) => ({ id: b.id, quantity: b.quantity.toString(), quarantined: b.quarantined })));
      return;
    }
    case 'ancestors': case 'descendants': {
      out(ledger[cmd](args[0]));
      return;
    }
    case 'paths': {
      out(ledger.paths(args[0]).map((p) => ({ path: p.path, ratio: p.ratio.toString() })));
      return;
    }
    case 'pollutes': {
      const r = ledger.pollutes(args[0], args[1]);
      out({
        polluted: r.polluted,
        reason: r.reason,
        certificate: r.certificate && { path: r.certificate.path, ratio: r.certificate.ratio.toString() },
      });
      return;
    }
    case 'quantity': {
      out(ledger.quantity(args[0], args[1] === undefined ? 6 : Number(args[1])));
      return;
    }
    default:
      process.stderr.write(USAGE + '\n');
      process.exitCode = cmd ? 2 : 0;
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof TraceError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
