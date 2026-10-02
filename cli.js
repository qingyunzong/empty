#!/usr/bin/env node
'use strict';

const { Store } = require('./src/store');
const { LineageError } = require('./src/lineage');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

const USAGE = `dairy-lineage CLI
  node cli.js --data <dir> add-lot <id> --kind K --qty N --status S
  node cli.js --data <dir> add-edge <id> <from> <to> --kind consume|split|merge|rework --qty N --ratio R --time T [--prob P]
  node cli.js --data <dir> impact <lot> [--threshold 0.5]
  node cli.js --data <dir> correct <edgeId> [--ratio R] [--qty N] [--prob P] [--time T]
  node cli.js --data <dir> undo | redo | snapshot
  node cli.js --data <dir> dump`;

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const dir = opts.data || './lineage-data';
  if (!cmd) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const store = Store.open(dir);
  switch (cmd) {
    case 'add-lot': {
      const [, id] = positional;
      store.addLot({ id, kind: opts.kind || 'wip', qty: Number(opts.qty), status: opts.status || 'in_stock' });
      console.log(JSON.stringify({ ok: true, lot: id }));
      break;
    }
    case 'add-edge': {
      const [, id, from, to] = positional;
      store.addEdge({
        id, from, to,
        kind: opts.kind,
        qty: Number(opts.qty),
        ratio: Number(opts.ratio),
        time: Number(opts.time),
        prob: opts.prob != null ? Number(opts.prob) : undefined,
      });
      console.log(JSON.stringify({ ok: true, edge: id }));
      break;
    }
    case 'impact': {
      const [, lot] = positional;
      const threshold = opts.threshold != null ? Number(opts.threshold) : 0.5;
      console.log(JSON.stringify(store.impact(lot, threshold), null, 2));
      break;
    }
    case 'correct': {
      const [, edgeId] = positional;
      const patch = {};
      for (const k of ['ratio', 'qty', 'prob', 'time']) {
        if (opts[k] != null) patch[k] = Number(opts[k]);
      }
      store.correctEdge(edgeId, patch);
      console.log(JSON.stringify({ ok: true, corrected: edgeId, patch }));
      break;
    }
    case 'undo':
      console.log(JSON.stringify({ ok: store.undo() }));
      break;
    case 'redo':
      console.log(JSON.stringify({ ok: store.redo() }));
      break;
    case 'snapshot':
      store.snapshot();
      console.log(JSON.stringify({ ok: true, snapshot: true }));
      break;
    case 'dump':
      console.log(JSON.stringify({
        lots: [...store.graph.lots.values()],
        edges: [...store.graph.edges.values()],
        applied: store.applied,
        ops: store.ops.length,
      }, null, 2));
      break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (err) {
  if (err instanceof LineageError || err.code) {
    console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }));
    process.exitCode = 1;
  } else {
    throw err;
  }
}
