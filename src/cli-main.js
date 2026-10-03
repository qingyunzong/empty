import { readFileSync } from 'node:fs';
import { prepare, runScenario } from './engine.js';

const USAGE = 'usage: tenant-sched [--pretty] [--check] <scenario.json | ->';

export function main(argv, io = {}) {
  const printOut = io.stdout ?? ((line) => console.log(line));
  const printErr = io.stderr ?? ((line) => console.error(line));
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));

  let pretty = false;
  let checkOnly = false;
  let file = null;
  for (const arg of argv) {
    if (arg === '--pretty') pretty = true;
    else if (arg === '--check') checkOnly = true;
    else if (arg === '--help' || arg === '-h') {
      printErr(USAGE);
      return 0;
    } else if (arg === '-') file = '-';
    else if (!arg.startsWith('-')) file = arg;
    else {
      printErr(`unknown option: ${arg}`);
      printErr(USAGE);
      return 2;
    }
  }

  if (!file) {
    printErr(USAGE);
    return 2;
  }

  let text;
  try {
    text = file === '-' ? readStdin() : readFileSync(file, 'utf8');
  } catch (err) {
    printErr(`error[IO]: ${err.message}`);
    return 1;
  }

  let scenario;
  try {
    scenario = JSON.parse(text);
  } catch (err) {
    printErr(`error[INVALID_JSON]: ${err.message}`);
    return 1;
  }

  try {
    if (checkOnly) {
      prepare(scenario);
      printOut(JSON.stringify({ ok: true }));
    } else {
      const report = runScenario(scenario);
      printOut(JSON.stringify(report, null, pretty ? 2 : 0));
    }
    return 0;
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      printErr(`error[${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
