#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, appendRecord, injectTornRecord, CRASH_POINTS, MAX_OPS, PersistError, InputError } from './log.js';
import { GraphError } from './graph.js';

function parseVertex(s) {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new InputError(`bad vertex: ${s}`);
  return Number(s);
}

function guardOpLimit(recordCount) {
  if (recordCount >= MAX_OPS) throw new InputError('op limit exceeded');
}

// Runs one CLI command. Returns { code, output } where output is the single
// printed line (OK / JSON result / error code).
export function runCli(argv, options = {}) {
  const logPath = options.logPath ?? process.env.GRAPH_LOG ?? path.resolve(process.cwd(), 'graph.log');
  const write = options.write ?? ((line) => process.stdout.write(line + '\n'));
  const [cmd, ...args] = argv;
  const needArgs = (n) => {
    if (args.length !== n) throw new InputError(`expected ${n} args, got ${args.length}`);
  };
  try {
    switch (cmd) {
      case 'add_edge': {
        needArgs(2);
        const u = parseVertex(args[0]);
        const v = parseVertex(args[1]);
        const st = replay(logPath);
        guardOpLimit(st.recordCount);
        st.graph.addEdge(u, v);
        appendRecord(logPath, { seq: st.recordCount + 1, op: 'add_edge', u, v });
        write('OK');
        return { code: 0, output: 'OK' };
      }
      case 'del_edge': {
        needArgs(2);
        const u = parseVertex(args[0]);
        const v = parseVertex(args[1]);
        const st = replay(logPath);
        guardOpLimit(st.recordCount);
        st.graph.delEdge(u, v);
        appendRecord(logPath, { seq: st.recordCount + 1, op: 'del_edge', u, v });
        write('OK');
        return { code: 0, output: 'OK' };
      }
      case 'query_bridges': {
        needArgs(0);
        const out = JSON.stringify(replay(logPath).graph.bridges());
        write(out);
        return { code: 0, output: out };
      }
      case 'query_articulation': {
        needArgs(0);
        const out = JSON.stringify(replay(logPath).graph.articulationPoints());
        write(out);
        return { code: 0, output: out };
      }
      case 'commit': {
        needArgs(0);
        const st = replay(logPath);
        guardOpLimit(st.recordCount);
        appendRecord(logPath, { seq: st.recordCount + 1, op: 'commit' });
        write('OK');
        return { code: 0, output: 'OK' };
      }
      case 'crash_sim': {
        needArgs(1);
        const point = args[0];
        if (!CRASH_POINTS.includes(point)) throw new InputError(`unknown crash point: ${point}`);
        const st = replay(logPath);
        const edges = st.graph.edges();
        const [u, v] = edges.length > 0 ? edges[0] : [0, 1];
        injectTornRecord(logPath, st.recordCount + 1, u, v);
        write('OK');
        return { code: 0, output: 'OK' };
      }
      case 'recover': {
        needArgs(0);
        const st = replay(logPath);
        const out = JSON.stringify({ applied: st.applied, discarded: st.discarded, state_hash: st.stateHash });
        write(out);
        return { code: 0, output: out };
      }
      default:
        throw new InputError(`unknown command: ${cmd ?? '(none)'}`);
    }
  } catch (e) {
    if (e instanceof GraphError || e instanceof PersistError || e instanceof InputError) {
      write(e.code);
      return { code: 1, output: e.code };
    }
    throw e;
  }
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runCli(process.argv.slice(2));
  process.exitCode = result.code;
}
