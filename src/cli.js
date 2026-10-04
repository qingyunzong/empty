#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { KittingEngine, KittingError } from './engine.js';

export const USAGE = 'usage: node src/cli.js kit <input.json> <commands.json> -o <out.json>';

class UsageError extends Error {}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const [command, ...rest] = argv;
  if (command !== 'kit') {
    throw new UsageError(`unknown subcommand: ${command ?? '(none)'}`);
  }
  const positional = [];
  let output = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '-o' || arg === '--output') {
      i += 1;
      if (i >= rest.length) throw new UsageError(`${arg} requires a path`);
      output = rest[i];
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new UsageError('expected <input.json> and <commands.json>');
  return { inputPath: positional[0], commandsPath: positional[1], output };
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new KittingError('IO', `cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new KittingError('IO', `cannot parse ${path}: ${error.message}`);
  }
}

export function run(argv, io) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    const input = readJson(args.inputPath);
    const commandsDoc = readJson(args.commandsPath);
    const commands = Array.isArray(commandsDoc) ? commandsDoc : commandsDoc?.commands;
    if (!Array.isArray(commands)) {
      throw new KittingError(
        'VALIDATION',
        'commands.json must be an array or an object with a commands array',
      );
    }
    const engine = new KittingEngine(input);
    let applied = 0;
    for (const command of commands) {
      engine.applyCommand(command);
      applied += 1;
    }
    const report = engine.report();
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      writeFileSync(args.output, text);
      const { totalOrders, shortOrders, totalBatches, heldBatches } = report.summary;
      io.stdout(
        `kit: applied ${applied} command(s); ${totalOrders} orders (${shortOrders} short), ` +
          `${totalBatches} batches (${heldBatches} held); report written to ${args.output}\n`,
      );
    } else {
      io.stdout(text);
    }
    return 0;
  } catch (error) {
    if (error instanceof KittingError) {
      io.stderr(`error [${error.code}]: ${error.message}\n`);
    } else {
      io.stderr(`error: ${error?.message ?? String(error)}\n`);
    }
    return 1;
  }
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
