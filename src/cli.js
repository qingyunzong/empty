#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Engine, EngineError } from './engine.js';
import { Journal } from './journal.js';

class CliError extends Error {}

export function runCli({ input, day, journalPath = null }) {
  const out = [];
  let journal = null;
  try {
    if (journalPath) journal = new Journal(journalPath);
    const engine = new Engine({ day: day ?? new Date().toISOString().slice(0, 10) });
    const emitEod = (lines) => {
      for (const line of lines) {
        if (journal) {
          const billed = journal.append({
            key: line.invoice.key,
            day: line.day,
            account: line.account,
            amount: line.net,
            certificate: line.certificate,
          });
          out.push(JSON.stringify({ ...line, billed }));
        } else {
          out.push(JSON.stringify(line));
        }
      }
    };
    const rows = input.split('\n');
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i].trim();
      if (!raw) continue;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        throw new CliError(`line ${i + 1}: invalid JSON`);
      }
      const res = engine.apply(ev);
      if (ev.type === 'eod') emitEod(res);
      else if (res) out.push(JSON.stringify(res));
    }
    emitEod(engine.eod());
    return { code: 0, stdout: out.length ? out.join('\n') + '\n' : '', stderr: '' };
  } catch (e) {
    const message = e instanceof EngineError || e instanceof CliError ? e.message : String(e);
    return {
      code: 6,
      stdout: out.length ? out.join('\n') + '\n' : '',
      stderr: `error: ${message}\n`,
    };
  } finally {
    if (journal) journal.close();
  }
}

export function main(argv, { input, stdout, stderr } = {}) {
  const writeOut = stdout ?? ((s) => process.stdout.write(s));
  const writeErr = stderr ?? ((s) => process.stderr.write(s));
  let file = null;
  let journalPath = null;
  let day = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--journal') journalPath = argv[++i];
    else if (argv[i] === '--day') day = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      writeOut('usage: cli.js [events.jsonl] [--day YYYY-MM-DD] [--journal path]\n');
      return 0;
    } else if (argv[i].startsWith('--')) {
      writeErr(`error: unknown option: ${argv[i]}\n`);
      return 6;
    } else if (file) {
      writeErr('error: multiple input files given\n');
      return 6;
    } else file = argv[i];
  }
  if (argv.includes('--journal') && !journalPath) {
    writeErr('error: --journal requires a path\n');
    return 6;
  }
  if (argv.includes('--day') && !day) {
    writeErr('error: --day requires a value\n');
    return 6;
  }
  let data = input;
  if (data === undefined) {
    try {
      data = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
    } catch (e) {
      writeErr(`error: cannot read input: ${e.message}\n`);
      return 6;
    }
  }
  const result = runCli({ input: data, day, journalPath });
  writeOut(result.stdout);
  writeErr(result.stderr);
  return result.code;
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invokedAsScript) {
  process.exit(main(process.argv.slice(2)));
}
