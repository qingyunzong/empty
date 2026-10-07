#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Engine } = require('./src/engine');

// Run a JSON command script (array or { commands: [...] }) and return the
// JSON result string. Throws on malformed input.
function runCli(text) {
  const input = JSON.parse(text);
  const commands = Array.isArray(input) ? input : input.commands;
  if (!Array.isArray(commands)) {
    throw new Error('input must be a JSON array of commands or { "commands": [...] }');
  }
  const engine = new Engine();
  const results = commands.map((c) => engine.exec(c));
  return JSON.stringify(results, null, 2) + '\n';
}

function main() {
  const file = process.argv[2];
  let text;
  try {
    text = file !== undefined ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
    process.stdout.write(runCli(text));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { runCli };
