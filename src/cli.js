#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CalibrationChain } from './chain.js';

function applyOp(chain, op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    return { ok: false, error: { code: 'E_OP', message: 'operation must be an object with an "op" field' } };
  }
  switch (op.op) {
    case 'addSensor':
      return chain.addSensor(op.id, { raw: op.raw, offset: op.offset, scale: op.scale });
    case 'removeSensor':
      return chain.removeSensor(op.id);
    case 'setCoefficients':
      return chain.setCoefficients(op.id, { raw: op.raw, offset: op.offset, scale: op.scale });
    case 'addCalibration':
      return chain.addCalibration(op.id, op.base);
    case 'removeCalibration':
      return chain.removeCalibration(op.id);
    case 'undo':
      return chain.undo();
    case 'redo':
      return chain.redo();
    case 'getResult':
      return chain.getResult(op.id);
    case 'snapshot':
      return { ok: true, snapshot: chain.snapshot() };
    case 'certificate':
      return { ok: true, certificate: chain.certificate() };
    default:
      return { ok: false, error: { code: 'E_OP', message: `unknown operation: ${op.op}` } };
  }
}

/** Execute a parsed request document and return the response object. */
export function executeRequest(input) {
  const ops = Array.isArray(input) ? input : Array.isArray(input?.ops) ? input.ops : [input];
  const chain = new CalibrationChain();
  const results = ops.map((op) => {
    const applied = applyOp(chain, op);
    return { op: op?.op ?? null, ...applied };
  });
  return { ok: true, results, snapshot: chain.snapshot() };
}

/** Execute a raw request string; returns exit code plus response object. */
export function runCliText(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch (err) {
    return {
      exitCode: 1,
      output: {
        ok: false,
        error: { code: 'E_INPUT', message: `invalid JSON on stdin: ${err.message}` },
      },
    };
  }
  return { exitCode: 0, output: executeRequest(input) };
}

export function main() {
  const { exitCode, output } = runCliText(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = exitCode;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main();
}
