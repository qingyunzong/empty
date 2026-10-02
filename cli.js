#!/usr/bin/env node
// CLI: reads a JSON document from stdin and writes a JSON result to stdout.
//
// Input:  { "now": <epoch ms>, "ops": [ { "op": <name>, ... }, ... ] }
// Output: { "ok": true, "results": [ { "ok": true, "value": ... } |
//                                     { "ok": false, "error": { "code", "message" } } ] }
//
// Ops: add_batch {id, concentration, expiry} | withdraw_batch {id}
//      correct_concentration {id, concentration} | set_expiry {id, expiry}
//      add_result {id, batch, protocol, deps?} | add_node {id, kind, deps?}
//      add_edge {node, depends_on} | add_substitute {result, batch}
//      remove_substitute {result, batch} | status {id} | certificate {id}
//      state_hash {} | undo {} | redo {}
// `expiry` accepts epoch ms (number), ISO 8601 string, or null.

import { Engine } from './src/engine.js';

function parseExpiry(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isNaN(t)) throw new Error(`invalid expiry: ${value}`);
    return t;
  }
  throw new Error(`invalid expiry type: ${typeof value}`);
}

function dispatch(engine, op) {
  switch (op.op) {
    case 'add_batch':
      return engine.addBatch({ id: op.id, concentration: op.concentration ?? null, expiry: parseExpiry(op.expiry) });
    case 'withdraw_batch':
      return engine.withdrawBatch(op.id);
    case 'correct_concentration':
      return engine.correctConcentration(op.id, op.concentration);
    case 'set_expiry':
      return engine.setExpiry(op.id, parseExpiry(op.expiry));
    case 'add_result':
      return engine.addResult({ id: op.id, batch: op.batch, protocol: op.protocol ?? '', deps: op.deps ?? [] });
    case 'add_node':
      return engine.addNode({ id: op.id, kind: op.kind, deps: op.deps ?? [] });
    case 'add_edge':
      return engine.addEdge(op.node, op.depends_on);
    case 'add_substitute':
      return engine.addSubstitute(op.result, op.batch);
    case 'remove_substitute':
      return engine.removeSubstitute(op.result, op.batch);
    case 'status':
      return engine.status(op.id);
    case 'certificate':
      return engine.certificate(op.id);
    case 'state_hash':
      return { ok: true, value: { stateHash: engine.stateHash() } };
    case 'undo':
      return engine.undo();
    case 'redo':
      return engine.redo();
    default:
      return { ok: false, error: { code: 'E_OP', message: `unknown op: ${op.op}` } };
  }
}

export function runCli(input) {
  let out;
  try {
    const doc = JSON.parse(input);
    const engine = new Engine({ now: doc.now ?? 0 });
    const results = (doc.ops ?? []).map((op) => dispatch(engine, op));
    out = { ok: true, results };
  } catch (err) {
    out = { ok: false, error: { code: 'E_PARSE', message: String(err.message) } };
  }
  return out;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify(runCli(input), null, 2) + '\n');
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
