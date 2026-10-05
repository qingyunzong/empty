'use strict';

const fs = require('fs');
const { Genealogy, GenealogyError } = require('./genealogy');
const { canonicalize } = require('./canonical');

const USAGE = 'usage: node src/cli.js trace <events.json> -o <result.json>';

function applyOp(g, op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new GenealogyError('INVALID_OP', 'each op must be an object');
  }
  switch (op.op) {
    case 'append':
      return g.appendEvent(op.event);
    case 'correct':
      return g.correctEvent(op.eventId, op.event);
    case 'undo':
      return g.undoEvent(op.eventId);
    case 'hold':
      return g.hold(op.batch);
    case 'release':
      return g.release(op.batch);
    case 'ship':
      return g.ship(op.batch);
    case 'query':
      return g.query(op.batch);
    default:
      throw new GenealogyError('UNKNOWN_OP', `unknown op: ${op.op}`);
  }
}

function runTrace(ops) {
  const g = new Genealogy();
  const results = [];
  let error = null;
  for (let i = 0; i < ops.length; i++) {
    try {
      results.push(applyOp(g, ops[i]));
    } catch (err) {
      if (err instanceof GenealogyError) {
        error = {
          index: i,
          op: ops[i] && ops[i].op !== undefined ? ops[i].op : null,
          code: err.code,
          message: err.message,
        };
        break;
      }
      throw err;
    }
  }
  const result = { ok: error === null, version: g.version, ops: results, finalState: g.snapshot() };
  if (error) result.error = error;
  return result;
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'trace') {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let eventsPath = null;
  let outPath = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '-o') {
      outPath = args[i + 1];
      i += 1;
    } else if (eventsPath === null) {
      eventsPath = args[i];
    } else {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }
  if (!eventsPath) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let ops;
  try {
    const raw = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    ops = Array.isArray(raw) ? raw : raw.ops;
    if (!Array.isArray(ops)) throw new Error('events file must be an array or { "ops": [...] }');
  } catch (err) {
    process.stderr.write(`error: cannot load events file: ${err.message}\n`);
    return 2;
  }

  const result = runTrace(ops);
  const text = `${JSON.stringify(canonicalize(result), null, 2)}\n`;
  if (outPath) {
    fs.writeFileSync(outPath, text);
    process.stdout.write(`ok=${result.ok} version=${result.version} ops=${result.ops.length} -> ${outPath}\n`);
  } else {
    process.stdout.write(text);
  }
  if (!result.ok) {
    process.stderr.write(
      `error: ${result.error.code}: ${result.error.message} (op index ${result.error.index})\n`,
    );
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main, runTrace, applyOp };
