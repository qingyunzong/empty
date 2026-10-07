#!/usr/bin/env node
import { Store, DEFAULT_THRESHOLD } from './store.js';
import { TraceError } from './graph.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const USAGE = `dairy-trace: dairy plant quality traceability CLI

usage: node src/cli.js [--db DIR] <command> [flags]

commands:
  add-lot   --id L --kind raw|wip|finished|in_transit|customer_order --qty N --time T [--failed] [--frozen]
  add-edge  --id E --from A --to B --kind consume|split|merge|rework --qty N --time T
  impact    --lot L [--threshold P]     affected lots + minimal recall certificate
  correct   --edge E (--qty N | --ratio R)   lab correction, incremental recompute
  undo                              undo last committed transaction
  redo                              redo last undone transaction
  snapshot                          dump graph, conservation check, undo depth

env: TRACE_DB (default ./trace_db), TRACE_CRASH_POINT=after_segment (fault injection)`;

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(USAGE);
    return;
  }
  const db = flags.db ?? process.env.TRACE_DB ?? './trace_db';
  const store = Store.open(db);
  let out;
  switch (cmd) {
    case 'add-lot':
      out = store.addLot({
        id: flags.id,
        kind: flags.kind ?? 'wip',
        qty: Number(flags.qty),
        time: flags.time ?? null,
        frozen: !!flags.frozen,
        failed: !!flags.failed,
      });
      break;
    case 'add-edge':
      out = store.addEdge({
        id: flags.id,
        from: flags.from,
        to: flags.to,
        kind: flags.kind,
        qty: Number(flags.qty),
        time: flags.time ?? null,
      });
      break;
    case 'impact':
      out = store.impact(flags.lot, flags.threshold !== undefined ? Number(flags.threshold) : DEFAULT_THRESHOLD);
      break;
    case 'correct':
      out = store.correct(
        flags.edge,
        flags.qty !== undefined ? { qty: Number(flags.qty) } : { ratio: Number(flags.ratio) },
      );
      break;
    case 'undo':
      out = store.undo();
      break;
    case 'redo':
      out = store.redo();
      break;
    case 'snapshot':
      out = store.snapshot();
      break;
    default:
      throw new TraceError('ERR_USAGE', `unknown command ${cmd}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

try {
  main();
} catch (err) {
  const code = err instanceof TraceError ? err.code : 'ERR_INTERNAL';
  console.error(JSON.stringify({ error: code, message: err.message }));
  process.exit(1);
}
