#!/usr/bin/env node
import { Inspector } from './inspector.js';
import { toErrorJSON, qerror } from './errors.js';

function runOperation(inspector, op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    throw qerror('E_OPERATION', 'each operation must be an object with an "op" field');
  }
  switch (op.op) {
    case 'defineCorrection':
      return inspector.defineCorrection(op.version, { x: op.x, y: op.y });
    case 'useCorrection':
      return inspector.useCorrection(op.version);
    case 'addPoint':
      return inspector.addPoint(op.id, op.x, op.y);
    case 'judge':
      return { id: op.id, judgment: inspector.getJudgment(op.id) };
    case 'analyze':
      return { id: op.id, analysis: inspector.analyze(op.id) };
    case 'undo':
      return inspector.undo();
    case 'redo':
      return inspector.redo();
    default:
      throw qerror('E_OPERATION', `unknown operation ${JSON.stringify(op.op)}`);
  }
}

// Pure session runner: parsed JSON input -> { output, exitCode }.
export function runSession(input) {
  try {
    const tolerance = input.tolerance || {};
    const inspector = new Inspector({
      polygon: tolerance.polygon,
      precision: input.precision !== undefined ? input.precision : 3,
    });
    const ops = input.operations || [];
    if (!Array.isArray(ops)) throw qerror('E_OPERATION', '"operations" must be an array');
    const results = ops.map((op) => {
      try {
        return { ok: true, ...runOperation(inspector, op) };
      } catch (e) {
        return { ok: false, error: toErrorJSON(e) };
      }
    });
    return { output: { ok: true, results }, exitCode: 0 };
  } catch (e) {
    return { output: { ok: false, error: toErrorJSON(e) }, exitCode: 1 };
  }
}

export function runRaw(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    return { output: { ok: false, error: { code: 'E_PARSE', message: e.message } }, exitCode: 1 };
  }
  return runSession(input);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const raw = await readStdin();
  const { output, exitCode } = runRaw(raw);
  process.stdout.write(JSON.stringify(output) + '\n');
  if (exitCode !== 0) process.exit(exitCode);
}
