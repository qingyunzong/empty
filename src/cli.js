#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TrustGraph, TrustGraphError } from './trust-graph.js';

function dispatch(graph, command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new TrustGraphError('INVALID_COMMAND', 'command must be a JSON object');
  }
  const { op } = command;
  switch (op) {
    case 'add-edge':
      graph.addEdge(command.from, command.to);
      return { op };
    case 'remove-edge':
      graph.removeEdge(command.from, command.to);
      return { op };
    case 'correct-direction':
      graph.correctDirection(command.from, command.to);
      return { op };
    case 'snapshot':
      return { op, ...graph.snapshot() };
    case 'rollback':
      return { op, ...graph.rollback(command.snapshot) };
    case 'query':
      return { op, result: graph.query() };
    default:
      throw new TrustGraphError('UNKNOWN_OP', `unknown op ${JSON.stringify(op)}`);
  }
}

export async function runCli(input, output) {
  const graph = new TrustGraph();
  let hadError = false;
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let command;
    try {
      command = JSON.parse(trimmed);
    } catch {
      hadError = true;
      write({ ok: false, error: { code: 'INVALID_JSON', message: 'line is not valid JSON' } });
      continue;
    }
    try {
      write({ ok: true, ...dispatch(graph, command) });
    } catch (err) {
      if (err instanceof TrustGraphError) {
        hadError = true;
        write({ ok: false, error: { code: err.code, message: err.message } });
      } else {
        throw err;
      }
    }
  }
  return hadError ? 1 : 0;
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await runCli(process.stdin, process.stdout);
}
