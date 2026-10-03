#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execute, explain, updateStats } from './engine.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      args[key] = argv[i + 1];
      i++;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readJson(source) {
  if (source.startsWith('@')) return JSON.parse(fs.readFileSync(source.slice(1), 'utf8'));
  if (fs.existsSync(source) && source.endsWith('.json')) {
    return JSON.parse(fs.readFileSync(source, 'utf8'));
  }
  return JSON.parse(source);
}

export function run(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!command || !args.db) {
    return {
      code: 2,
      error: 'usage: cli.js <explain|execute|update-stats> --db DIR [--query FILE] [--table NAME] [--stats JSON|@FILE]',
    };
  }
  try {
    let result;
    if (command === 'explain') {
      result = explain(args.db, readJson(args.query));
    } else if (command === 'execute') {
      result = execute(args.db, readJson(args.query));
    } else if (command === 'update-stats') {
      if (!args.table || !args.stats) {
        throw new Error('update-stats requires --table and --stats');
      }
      result = updateStats(args.db, args.table, readJson(args.stats));
    } else {
      throw new Error(`unknown command: ${command}`);
    }
    return { code: 0, result };
  } catch (err) {
    return { code: 1, error: err.message };
  }
}

function main() {
  const { code, result, error } = run(process.argv.slice(2));
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  if (error !== undefined) console.error(JSON.stringify({ error }));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
