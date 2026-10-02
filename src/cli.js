#!/usr/bin/env node
'use strict';

const { Workspace } = require('./workspace.js');

function applyOp(ws, op) {
  switch (op.op) {
    case 'move':
      ws.moveDefect(op.defect, op.dx === undefined ? 0 : op.dx, op.dy === undefined ? 0 : op.dy);
      return { ok: true };
    case 'scale':
      ws.scaleDefect(op.defect, op.factor, op.anchor);
      return { ok: true };
    case 'split':
      ws.splitDefect(op.defect, op.axis, op.at, op.newId);
      return { ok: true };
    case 'undo':
      return { ok: ws.undo() };
    case 'redo':
      return { ok: ws.redo() };
    default:
      throw new TypeError(`unknown op ${JSON.stringify(op.op)}`);
  }
}

function run(input) {
  const ws = Workspace.fromSpec(input);
  const results = [];
  for (const op of input.ops || []) {
    try {
      results.push({ op, ...applyOp(ws, op) });
    } catch (err) {
      results.push({ op, ok: false, rolledBack: err.rolledBack === true, error: err.message });
    }
  }
  return {
    ops: results,
    undoDepth: ws.undoStack.length,
    redoDepth: ws.redoStack.length,
    report: ws.report(),
  };
}

function main() {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(text);
      process.stdout.write(`${JSON.stringify(run(input), null, 2)}\n`);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
  });
}

if (require.main === module) main();

module.exports = { run };
