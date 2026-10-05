'use strict';

import { AgvGraph, ERR } from './graph.js';

function fail(error, extra) {
  return Object.assign({ ok: false, error }, extra);
}

/**
 * Execute one decoded JSONL command object against the graph and return the
 * result object (without the echo id; the CLI adds that).
 */
export function dispatch(graph, cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    return fail(ERR.INVALID_INPUT);
  }
  switch (cmd.cmd) {
    case 'add_edge':
      return graph.addEdge(cmd.u, cmd.v, cmd.cost);
    case 'close':
      return graph.closeEdge(cmd.u, cmd.v);
    case 'open':
      return graph.openEdge(cmd.u, cmd.v);
    case 'set_cost':
      return graph.setCost(cmd.u, cmd.v, cmd.cost);
    case 'query':
      return graph.query(cmd.from, cmd.to);
    case 'undo':
      return graph.undo();
    case 'verify':
      return graph.verify(cmd.cert);
    default:
      return fail(ERR.INVALID_INPUT, { reason: 'unknown cmd' });
  }
}

export { AgvGraph, ERR };
