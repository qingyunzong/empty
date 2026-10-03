// CLI logic, importable for in-process testing. Returns the exit code.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseInstance } from './instance.js';
import { solve } from './solver.js';
import { verifySolution } from './verify.js';

const USAGE = `usage:
  mold-sched solve <instance.json|-> [--out solution.json]
  mold-sched verify <instance.json> <solution.json>
  mold-sched <instance.json>            (same as solve)`;

export function runCli(argv, io = {}) {
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));
  const writeOut = io.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = io.writeErr ?? ((s) => process.stderr.write(s));

  const readJson = (path) => {
    const text = path === '-' ? readStdin() : readFileSync(path, 'utf8');
    return JSON.parse(text);
  };

  try {
    const [cmd, ...rest] = argv;
    if (cmd === 'verify') {
      const [instPath, solPath] = rest;
      if (!instPath || !solPath) {
        writeErr(`${USAGE}\n`);
        return 1;
      }
      const inst = parseInstance(readJson(instPath));
      const sol = readJson(solPath);
      const result = verifySolution(inst, sol);
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }

    let file;
    let out = null;
    const args = cmd === 'solve' ? rest : argv;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--out') {
        out = args[i + 1];
        i += 1;
      } else if (file === undefined) {
        file = args[i];
      } else {
        writeErr(`${USAGE}\n`);
        return 1;
      }
    }
    if (file === undefined) {
      writeErr(`${USAGE}\n`);
      return 1;
    }
    const inst = parseInstance(readJson(file));
    const result = solve(inst);
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (out) writeFileSync(out, text);
    writeOut(text);
    return 0;
  } catch (err) {
    writeErr(`error: ${err.message}\n`);
    return 1;
  }
}
