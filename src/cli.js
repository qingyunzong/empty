#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { tarjanScc, kosarajuScc, componentsEqual, canonicalComponents } from './graph.js';
import {
  commit,
  recover,
  verify,
  stateEdges,
  stateRoot,
  SCC_CROSSCHECK_MAX_NODES,
} from './store.js';

const CRASH_STAGES = new Set(['before-checkpoint', 'after-checkpoint']);

export function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        opts[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        opts[body] = argv[i + 1];
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

// Runs one CLI command in-process. Returns the process exit code.
// io.log / io.error capture output; crash stages are reported via the
// return code (3) instead of an actual process.exit so tests can drive it.
export function run(argv, io = { log: console.log, error: console.error }) {
  const { positional, opts } = parseArgs(argv);
  const [command, ...args] = positional;
  const dir = opts.dir ?? process.cwd();
  const crash = opts.crash ?? null;
  if (crash !== null && !CRASH_STAGES.has(crash)) {
    io.error(`error: unknown --crash stage: ${crash}`);
    return 1;
  }

  switch (command) {
    case 'add-edge':
    case 'delete-edge': {
      const [from, to] = args;
      if (!from || !to) {
        io.error(`error: usage: ${command} <from> <to> [--dir D] [--crash STAGE]`);
        return 1;
      }
      let result;
      try {
        result = commit(dir, { op: command, from, to }, crash);
      } catch (err) {
        io.error(`error: ${err.message}`);
        return 1;
      }
      if (result.crashed) {
        io.error(`simulated crash: ${result.stage} (seq=${result.record.seq})`);
        return 3;
      }
      io.log(JSON.stringify({ committed: result.record }));
      return 0;
    }
    case 'query-scc': {
      let rec;
      try {
        rec = recover(dir);
      } catch (err) {
        io.error(`error: ${err.message}`);
        return 1;
      }
      const nodes = [...rec.state.nodes];
      const edges = stateEdges(rec.state);
      const components = canonicalComponents(tarjanScc(nodes, edges));
      if (nodes.length <= SCC_CROSSCHECK_MAX_NODES) {
        const independent = kosarajuScc(nodes, edges);
        if (!componentsEqual(components, independent)) {
          io.error('error: SCC cross-check failed: Tarjan and Kosaraju disagree');
          return 1;
        }
      }
      io.log(
        JSON.stringify({
          components,
          appliedCount: rec.state.appliedCount,
          logLength: rec.records.length,
          checkpointedSeq: rec.checkpoint ? rec.checkpoint.lastSeq : 0,
          stateRoot: stateRoot(rec.state),
        }),
      );
      return 0;
    }
    case 'verify-history': {
      try {
        const report = verify(dir);
        io.log(
          `OK events=${report.events} checkpointedSeq=${report.checkpointedSeq} ` +
            `tipHash=${report.tipHash.slice(0, 16)}... stateRoot=${report.stateRoot.slice(0, 16)}...`,
        );
        return 0;
      } catch (err) {
        io.error(`VERIFY FAILED: ${err.message}`);
        return 1;
      }
    }
    default:
      io.error('error: usage: <add-edge|delete-edge|query-scc|verify-history> ...');
      return 1;
  }
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exit(run(process.argv.slice(2)));
}
