#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { compileSource } from './index.js';
import { VM } from './vm.js';
import { DslError, DslErrorList } from './errors.js';

const USAGE = 'usage: node src/cli.js run <machine.dsl> <commands.jsonl> [--trace <out.json>]';

function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'run' || args.length < 3) {
    console.error(USAGE);
    return 1;
  }
  const [, dslPath, commandsPath, ...rest] = args;
  let tracePath = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--trace' && i + 1 < rest.length) {
      tracePath = rest[i + 1];
      i += 1;
    } else {
      console.error(`unknown option '${rest[i]}'\n${USAGE}`);
      return 1;
    }
  }

  let source;
  try {
    source = readFileSync(dslPath, 'utf8');
  } catch (e) {
    console.error(`cannot read ${dslPath}: ${e.message}`);
    return 1;
  }

  let program;
  try {
    program = compileSource(source);
  } catch (e) {
    if (e instanceof DslErrorList) {
      for (const err of e.errors) {
        console.error(`${dslPath}:${err.line}:${err.col}: error: ${err.message}`);
      }
      return 2;
    }
    if (e instanceof DslError) {
      console.error(`${dslPath}:${e.line}:${e.col}: error: ${e.message}`);
      return 2;
    }
    throw e;
  }

  let commandsText;
  try {
    commandsText = readFileSync(commandsPath, 'utf8');
  } catch (e) {
    console.error(`cannot read ${commandsPath}: ${e.message}`);
    return 1;
  }
  const commands = [];
  const lines = commandsText.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n].trim();
    if (line === '') continue;
    try {
      commands.push(JSON.parse(line));
    } catch (e) {
      console.error(`${commandsPath}:${n + 1}: invalid JSON: ${e.message}`);
      return 3;
    }
  }

  const vm = new VM(program);
  const entries = [];
  let accepted = 0;
  let rejected = 0;
  commands.forEach((cmd, i) => {
    const result = vm.applyCommand(cmd);
    if (result.accepted) accepted += 1;
    else rejected += 1;
    entries.push({
      seq: i,
      tick: typeof cmd.tick === 'number' ? cmd.tick : null,
      command: cmd,
      accepted: result.accepted,
      reason: result.reason,
      state: vm.snapshot(),
    });
  });

  const trace = {
    program: dslPath,
    commands: commandsPath,
    accepted,
    rejected,
    entries,
    finalState: vm.snapshot(),
  };
  const json = JSON.stringify(trace, null, 2);
  if (tracePath) {
    writeFileSync(tracePath, json + '\n');
    console.log(`trace written to ${tracePath}: ${accepted} accepted, ${rejected} rejected`);
  } else {
    console.log(json);
  }
  return 0;
}

process.exitCode = main(process.argv);
