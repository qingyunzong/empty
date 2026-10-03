import fs from 'node:fs';
import { MetrologyError, EXIT } from './errors.js';
import { isValidDateString } from './dates.js';
import { loadInstruments, loadCalibrations, loadUsage } from './model.js';
import { evaluateUsage, buildStatus, buildImpact, minimalRevocations } from './evaluate.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new MetrologyError(`unexpected argument "${arg}"`, EXIT.VALIDATION);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new MetrologyError(`missing value for ${arg}`, EXIT.VALIDATION);
    }
    args[arg.slice(2)] = value;
    i += 1;
  }
  return args;
}

function readInput(path, flag) {
  if (!path) throw new MetrologyError(`missing required option --${flag}`, EXIT.VALIDATION);
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    throw new MetrologyError(`cannot read ${path}`, EXIT.VALIDATION);
  }
}

export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    const args = parseArgs(argv);
    const asOf = args['as-of'] ?? new Date().toISOString().slice(0, 10);
    if (!isValidDateString(asOf)) {
      throw new MetrologyError(`invalid --as-of date ${JSON.stringify(asOf)}`, EXIT.INVALID_DATE);
    }

    let instrumentsRaw;
    try {
      instrumentsRaw = JSON.parse(readInput(args.instruments, 'instruments'));
    } catch (err) {
      if (err instanceof MetrologyError) throw err;
      throw new MetrologyError('instruments.json: invalid JSON', EXIT.VALIDATION);
    }
    const model = loadInstruments(instrumentsRaw);
    const { certificates } = loadCalibrations(readInput(args.calibrations, 'calibrations'), model);
    const usages = loadUsage(readInput(args.usage, 'usage'), model);

    const evaluated = usages.map((u) => evaluateUsage(certificates, u));
    const status = buildStatus(model, certificates, asOf);
    const impact = buildImpact(evaluated);

    fs.writeFileSync(args['status-out'] ?? 'status.json', `${JSON.stringify(status, null, 2)}\n`);
    fs.writeFileSync(args['impact-out'] ?? 'impact.jsonl', impact.map((l) => JSON.stringify(l)).join('\n') + (impact.length > 0 ? '\n' : ''));

    if (args.counterexample !== undefined) {
      const revokeAt = args['revoke-at'] ?? asOf;
      if (!isValidDateString(revokeAt)) {
        throw new MetrologyError(`invalid --revoke-at date ${JSON.stringify(revokeAt)}`, EXIT.INVALID_DATE);
      }
      const result = minimalRevocations(certificates, usages, args.counterexample, revokeAt);
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof MetrologyError) {
      io.stderr(`error: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}
