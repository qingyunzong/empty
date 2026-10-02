#!/usr/bin/env node
'use strict';

const { Store } = require('./src/store');
const { Engine } = require('./src/engine');

// Execute a list of JSON commands against the state file, returning one
// result object per command. Exported for in-process testing; the CLI
// wrapper below reads commands from stdin and prints results as JSON.
function runCommands(commands, statePath) {
  const engine = new Engine(new Store(statePath));
  return commands.map((cmd) => {
    try {
      return { ok: true, ...engine.execute(cmd) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const statePath = process.argv[2] || 'state.json';
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error('usage: node cli.js <stateFile>  (JSON command or array of commands on stdin)');
    process.exit(2);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    console.log(JSON.stringify([{ ok: false, error: `invalid JSON input: ${err.message}` }]));
    process.exit(1);
  }
  const commands = Array.isArray(input) ? input : [input];
  const results = runCommands(commands, statePath);
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runCommands };
