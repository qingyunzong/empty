#!/usr/bin/env node
// Usage: node cli.js <log-file> <command> [args]
//   add_edge <u> <v>        append + apply an edge insertion
//   del_edge <u> <v>        append + apply an edge deletion
//   query_bridges           print sorted JSON list of [u, v] bridges
//   query_articulation      print sorted JSON list of articulation points
//   commit                  append a durability checkpoint (append + fsync)
//   crash_sim <point>       inject truncated bytes at a fault point
//                           (after_append|before_fsync|after_index_commit or 1|2|3)
//   recover                 replay confirmed (complete) records, discard a
//                           torn half record, print
//                           {"applied":N,"discarded":M,"state_hash":"..."}
// Errors print one of: INVALID_INPUT, NO_SUCH_EDGE, PERSIST_CORRUPT (exit 1).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor } from './src/monitor.js';

function parseVertex(s) {
  return typeof s === 'string' && /^-?\d+$/.test(s) ? Number(s) : NaN;
}

// Runs one CLI command. Returns the exit code; each output line is passed
// to `write`. Exported so tests can drive the CLI in-process.
export function runCli(argv, write = (line) => console.log(line)) {
  const [logPath, cmd, ...args] = argv;
  if (!logPath || !cmd) {
    console.error('usage: node cli.js <log-file> <command> [args]');
    return 2;
  }
  const fail = (code) => {
    write(code);
    return 1;
  };
  try {
    switch (cmd) {
      case 'add_edge': {
        const m = new Monitor(logPath);
        const r = m.addEdge(parseVertex(args[0]), parseVertex(args[1]));
        if (r !== 'OK') return fail(r);
        write('OK');
        return 0;
      }
      case 'del_edge': {
        const m = new Monitor(logPath);
        const r = m.delEdge(parseVertex(args[0]), parseVertex(args[1]));
        if (r !== 'OK') return fail(r);
        write('OK');
        return 0;
      }
      case 'query_bridges': {
        const m = new Monitor(logPath);
        write(JSON.stringify(m.queryBridges()));
        return 0;
      }
      case 'query_articulation': {
        const m = new Monitor(logPath);
        write(JSON.stringify(m.queryArticulation()));
        return 0;
      }
      case 'commit': {
        const m = new Monitor(logPath);
        m.commit();
        write('OK');
        return 0;
      }
      case 'crash_sim': {
        const m = new Monitor(logPath);
        const r = m.crashSim(args[0]);
        if (r !== 'OK') return fail(r);
        write('OK');
        return 0;
      }
      case 'recover': {
        const m = new Monitor(logPath, { autoRecover: false });
        write(JSON.stringify(m.recover()));
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        return 2;
    }
  } catch (e) {
    if (e && e.code === 'PERSIST_CORRUPT') return fail('PERSIST_CORRUPT');
    throw e;
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  process.exit(runCli(process.argv.slice(2)));
}
