#!/usr/bin/env node
import readline from 'node:readline';
import { DynamicGraph, GraphError, ERRORS } from './src/graph.js';

export function handleCommand(graph, cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new GraphError(ERRORS.INVALID_INPUT, 'command must be a JSON object');
  }
  switch (cmd.op) {
    case 'add_edge': {
      const id = graph.addEdge({ id: cmd.id, from: cmd.from, to: cmd.to, cost: cmd.cost });
      return { ok: true, id, version: graph.version };
    }
    case 'close':
      graph.close(cmd.id);
      return { ok: true, version: graph.version };
    case 'open':
      graph.open(cmd.id);
      return { ok: true, version: graph.version };
    case 'set_cost':
      graph.setCost(cmd.id, cmd.cost);
      return { ok: true, version: graph.version };
    case 'query': {
      const { path, cost, cert } = graph.query(cmd.from, cmd.to);
      return { ok: true, path, cost, cert };
    }
    case 'undo':
      graph.undo();
      return { ok: true, version: graph.version };
    case 'verify':
      graph.verify(cmd.cert);
      return { ok: true };
    default:
      throw new GraphError(ERRORS.INVALID_INPUT, `unknown op: ${JSON.stringify(cmd.op)}`);
  }
}

export function processLine(graph, line) {
  try {
    const cmd = JSON.parse(line);
    return handleCommand(graph, cmd);
  } catch (err) {
    if (err instanceof GraphError) {
      return { ok: false, error: err.code, message: err.message };
    }
    return { ok: false, error: ERRORS.INVALID_INPUT, message: String(err?.message ?? err) };
  }
}

async function main() {
  const graph = new DynamicGraph();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    process.stdout.write(`${JSON.stringify(processLine(graph, trimmed))}\n`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main();
}
