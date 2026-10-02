#!/usr/bin/env node
'use strict';

const { CalibrationChain } = require('./calibration');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function runCommand(chain, cmd) {
  const op = cmd.op;
  switch (op) {
    case 'addSensor':
      return { op, ...chain.addSensor(cmd.id, cmd) };
    case 'removeSensor':
      return { op, ...chain.removeSensor(cmd.id) };
    case 'setBase':
      return { op, ...chain.setBase(cmd.id, cmd.base) };
    case 'removeBase':
      return { op, ...chain.removeBase(cmd.id) };
    case 'correct':
      return { op, ...chain.correctCoefficients(cmd.id, cmd) };
    case 'undo':
      return { op, ...chain.undo() };
    case 'redo':
      return { op, ...chain.redo() };
    case 'result':
      return { op, ...chain.getResult(cmd.id) };
    case 'results':
      return { op, ok: true, results: chain.getResults() };
    case 'certificate':
      return { op, ok: true, certificate: chain.getCertificate() };
    case 'snapshot':
      return {
        op,
        ok: true,
        results: chain.getResults(),
        certificate: chain.getCertificate(),
      };
    default:
      return { op: op ?? null, ok: false, error: 'E_OP' };
  }
}

async function main() {
  const input = await readStdin();
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    process.stdout.write(
      JSON.stringify({ ok: false, error: 'E_PARSE' }) + '\n'
    );
    process.exitCode = 1;
    return;
  }
  const commands = Array.isArray(request) ? request : request.commands;
  if (!Array.isArray(commands)) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: 'E_REQUEST' }) + '\n'
    );
    process.exitCode = 1;
    return;
  }
  const chain = new CalibrationChain();
  const results = commands.map((cmd) => runCommand(chain, cmd));
  process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { runCommand };
