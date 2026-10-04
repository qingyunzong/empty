#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { QueryError } from './src/query.js';
import { runCommand } from './src/commands.js';

const USAGE = `usage:
  node cli.js explain      --catalog C.json --query Q.json [--data D.json]
  node cli.js execute      --catalog C.json --data D.json --query Q.json
  node cli.js update-stats --catalog C.json --data D.json --query Q.json --table T --stats S.json`;

function readJson(path, flag) {
  if (!path) throw new QueryError(`missing required option --${flag}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      catalog: { type: 'string' },
      data: { type: 'string' },
      query: { type: 'string' },
      table: { type: 'string' },
      stats: { type: 'string' },
    },
  });
  const catalog = readJson(values.catalog, 'catalog');
  const query = readJson(values.query, 'query');
  const data = values.data ? readJson(values.data, 'data') : {};
  if (!['explain', 'execute', 'update-stats'].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }
  const stats = values.stats ? readJson(values.stats, 'stats') : undefined;
  console.log(runCommand(command, { catalog, data, query, table: values.table, stats }));
}

try {
  main();
} catch (err) {
  if (err instanceof QueryError) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
