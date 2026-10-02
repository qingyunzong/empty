#!/usr/bin/env node
// CLI: reads one JSON document from stdin, writes one JSON line to stdout.
// Input:  {"commands": [ ... ]} (a bare array or single object also works)
// Output: {"results": [ ... ]} with one entry per command, in order.

import { CausalHistory, HistoryError } from './history.js';
import { RationalError } from './rational.js';

function runCommand(history, cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new HistoryError('E_RANGE', 'command must be an object');
  }
  switch (cmd.op) {
    case 'add_event':
      return { event: history.addEvent(cmd) };
    case 'correct':
      return { event: history.correct(cmd) };
    case 'add_constraint':
      return { constraint: history.addConstraint(cmd) };
    case 'undo':
      return history.undo();
    case 'redo':
      return history.redo();
    case 'query': {
      const { relation, certificate } = history.relation(cmd.x, cmd.y);
      return { relation, certificate };
    }
    case 'linearizations':
      return history.linearizations();
    case 'snapshot':
      return history.snapshot();
    default:
      throw new HistoryError('E_RANGE', `unknown op: ${cmd.op}`);
  }
}

export function run(input) {
  const commands = Array.isArray(input)
    ? input
    : Array.isArray(input?.commands)
      ? input.commands
      : [input];
  const history = new CausalHistory();
  const results = [];
  for (const cmd of commands) {
    try {
      results.push({ ok: true, ...runCommand(history, cmd) });
    } catch (err) {
      const code =
        err instanceof HistoryError || err instanceof RationalError
          ? err.code
          : 'E_INTERNAL';
      results.push({ ok: false, error: code, message: err.message });
    }
  }
  return { results };
}

function main() {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    text += chunk;
  });
  process.stdin.on('end', () => {
    let output;
    try {
      output = run(JSON.parse(text));
    } catch (err) {
      output = {
        results: [{ ok: false, error: 'E_PARSE', message: String(err.message) }],
      };
    }
    process.stdout.write(JSON.stringify(output) + '\n');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
