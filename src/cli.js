import { readFileSync } from 'node:fs';
import { WindowEngine, FatalInputError } from './windows.js';

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const fail = (obj) => {
    io.stderr.write(`${JSON.stringify(obj)}\n`);
    throw new ExitSignal(2);
  };
  try {
    const args = argv.slice(2);
    const command = args[0];
    if (command !== 'windows') {
      fail({
        error: 'INVALID_INPUT',
        message: 'usage: node src/cli.js windows --in <samples.jsonl>',
      });
    }
    const inIndex = args.indexOf('--in');
    const inputPath = inIndex >= 0 ? args[inIndex + 1] : undefined;
    if (!inputPath) {
      fail({ error: 'INVALID_INPUT', message: 'missing required --in <file> argument' });
    }
    let text;
    try {
      text = readFileSync(inputPath, 'utf8');
    } catch (err) {
      fail({
        error: 'INVALID_INPUT',
        message: `cannot read input file: ${inputPath}`,
        detail: err.message,
      });
    }

    const engine = new WindowEngine();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      const raw = lines[i].trim();
      if (raw === '') continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch (err) {
        fail({
          error: 'INVALID_INPUT',
          line: lineNo,
          message: 'malformed JSON line',
          detail: err.message,
        });
      }
      let result;
      try {
        result = engine.apply(event);
      } catch (err) {
        if (err instanceof FatalInputError) {
          fail({ error: err.code, line: lineNo, message: err.message });
        }
        throw err;
      }
      for (const output of result.outputs) {
        io.stdout.write(`${JSON.stringify(output)}\n`);
      }
      if (result.error) {
        io.stderr.write(`${JSON.stringify({ line: lineNo, ...result.error })}\n`);
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  process.exitCode = run(process.argv);
}
