#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Engine, EngineError } from './src/engine.js';
import { DEFAULT_PATTERNS } from './src/defaults.js';

export function runCli(argv, io) {
  const [eventsPath, patternsPath] = argv;
  if (!eventsPath) {
    io.err('usage: node cli.js <events.jsonl> [patterns.json]');
    return 2;
  }
  let patterns = DEFAULT_PATTERNS;
  if (patternsPath) {
    try {
      patterns = JSON.parse(readFileSync(patternsPath, 'utf8'));
    } catch (error) {
      io.err(`error: cannot load patterns file: ${error.message}`);
      return 2;
    }
  }
  let lines;
  try {
    lines = readFileSync(eventsPath, 'utf8').split('\n');
  } catch (error) {
    io.err(`error: cannot read events file: ${error.message}`);
    return 2;
  }
  let engine;
  try {
    engine = new Engine(patterns);
  } catch (error) {
    if (error instanceof EngineError) {
      io.err(`error: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      io.err(`error: line ${index + 1}: invalid JSON`);
      return 3;
    }
    try {
      for (const output of engine.apply(op)) {
        io.out(JSON.stringify(output));
      }
    } catch (error) {
      if (error instanceof EngineError) {
        io.err(`error: line ${index + 1}: ${error.message}`);
        return error.exitCode;
      }
      throw error;
    }
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  try {
    process.exitCode = runCli(process.argv.slice(2), {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`fatal: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
