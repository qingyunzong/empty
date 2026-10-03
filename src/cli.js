'use strict';

const fs = require('node:fs');
const { Engine } = require('./engine');

const USAGE = 'usage: node src/cli.js kit <input.json> <commands.json> [-o out.json]';

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.exitCode = code;
  }
}

function readJson(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`cannot read file: ${path}`, 1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`cannot parse JSON in ${path}: ${err.message}`, 1);
  }
}

// Returns the process exit code. io defaults to the real process streams
// so tests can capture output in-process.
function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const [subcommand, ...rest] = argv;
    if (subcommand !== 'kit') throw new CliError(USAGE, 2);

    const positionals = [];
    let outPath = null;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '-o' || arg === '--output') {
        outPath = rest[++i];
        if (!outPath) throw new CliError('missing value for -o', 2);
      } else if (arg.startsWith('-')) {
        throw new CliError(`unknown option: ${arg}`, 2);
      } else {
        positionals.push(arg);
      }
    }
    if (positionals.length !== 2) throw new CliError(USAGE, 2);

    const input = readJson(positionals[0]);
    const commands = readJson(positionals[1]);
    if (!Array.isArray(commands)) {
      throw new CliError('commands.json must contain an array of commands', 1);
    }

    const engine = new Engine(input);
    engine.applyAll(commands);

    const output = `${JSON.stringify(engine.snapshot(), null, 2)}\n`;
    if (outPath) {
      fs.writeFileSync(outPath, output);
    } else {
      io.stdout.write(output);
    }
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run, USAGE };
