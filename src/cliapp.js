'use strict';

const { Engine } = require('./sim');
const { ProtocolError, BusinessError } = require('./errors');

// Runs a JSONL script and returns { exitCode, output } without touching
// process.stdout, so it can be tested in-process.
function runScript(text) {
  const engine = new Engine();
  const rows = String(text).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  for (let i = 0; i < rows.length; i++) {
    let op;
    try {
      op = JSON.parse(rows[i]);
    } catch {
      return err('BAD_INPUT', `line ${i + 1}: invalid JSON`, 2);
    }
    try {
      switch (op.op) {
        case 'init': engine.configure(op); break;
        case 'submit': engine.submit(op); break;
        case 'pump': engine.pump(op); break;
        case 'tick': engine.tick(op.ms ?? 0); break;
        case 'feed': engine.feedHex(op.hex); break;
        case 'reverse': engine.reverse(op); break;
        default: return err('BAD_INPUT', `line ${i + 1}: unknown op ${JSON.stringify(op.op)}`, 2);
      }
    } catch (e) {
      if (e instanceof ProtocolError) return err('PROTOCOL_ERROR', `line ${i + 1}: ${e.message}`, 2);
      if (e instanceof BusinessError) return err('BUSINESS_REJECTED', `line ${i + 1}: ${e.message}`, 3);
      throw e;
    }
  }
  return { exitCode: 0, output: JSON.stringify({ ok: true, ...engine.result() }, null, 2) + '\n' };
}

function err(code, message, exitCode) {
  return { exitCode, output: JSON.stringify({ ok: false, code, message }) + '\n' };
}

module.exports = { runScript };
