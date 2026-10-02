#!/usr/bin/env node
'use strict';

const { OvenController } = require('./controller');
const { CodeError } = require('./errors');

const USAGE = `Usage:
  node src/cli.js quantize --coeffs c0,c1,... --lo LO --hi HI --k K

  Coefficients and bounds are exact rationals: "p/q", integers, or decimals.
  Prints JSON with the exact interval, quantized value, and error bound.
  Exit code 0 on success, 1 with {"error": "E_*"} on failure.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// Returns { code, stdout, stderr } so it can be tested in-process.
function run(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command !== 'quantize') {
    return { code: 2, stdout: '', stderr: `${USAGE}\n` };
  }
  try {
    const coeffs = String(args.coeffs ?? '').split(',').filter((s) => s.trim() !== '');
    const k = Number(args.k);
    const controller = new OvenController(coeffs);
    const result = controller.instruction(args.lo, args.hi, k);
    const out = {
      interval: { min: result.interval.min.toString(), max: result.interval.max.toString() },
      value: result.value.toString(),
      errorBound: result.errorBound.toString(),
    };
    return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '' };
  } catch (err) {
    const code = err instanceof CodeError ? err.code : 'E_INTERNAL';
    return { code: 1, stdout: '', stderr: `${JSON.stringify({ error: code, message: err.message })}\n` };
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

module.exports = { run };
