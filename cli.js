#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Engine } = require('./src/engine');

const errObj = (e) => ({ error: e.code || 'ERROR', message: e.message });

function readLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function runCommand(engine, c) {
  switch (c.cmd) {
    case 'load': {
      const lines = c.lines !== undefined ? c.lines : readLines(c.file);
      engine.load(lines);
      return { ok: true, lines: engine.lines.length };
    }
    case 'patch':
      return engine.patch(c.line, c.text);
    case 'scan':
      return engine.scan();
    case 'verify':
      return engine.verify(c.proof);
    default:
      return { error: 'BAD_COMMAND', message: `unknown cmd '${c.cmd}'` };
  }
}

// argv: process.argv.slice(2); io: { stdin?: string, write(line) }
async function main(argv, io) {
  const write = io && io.write ? io.write : (l) => process.stdout.write(l + '\n');
  const [cmd, ...args] = argv;
  if (cmd === 'scan') {
    const [file, rulesFile] = args;
    if (!file || !rulesFile) {
      throw Object.assign(new Error('usage: node cli.js scan <file.jsonl> <rules.json>'), { code: 'USAGE' });
    }
    const engine = new Engine(JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
    engine.load(readLines(file));
    write(JSON.stringify(engine.scan()));
    return;
  }
  if (cmd === 'exec') {
    const [rulesFile] = args;
    if (!rulesFile) {
      throw Object.assign(new Error('usage: node cli.js exec <rules.json>'), { code: 'USAGE' });
    }
    const engine = new Engine(JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
    const stdin = io && io.stdin !== undefined
      ? io.stdin
      : await new Promise((resolve) => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (d) => { buf += d; });
          process.stdin.on('end', () => resolve(buf));
        });
    for (const line of stdin.split('\n')) {
      if (!line.trim()) continue;
      let c;
      try {
        c = JSON.parse(line);
      } catch {
        write(JSON.stringify({ error: 'BAD_COMMAND', message: 'command line is not valid JSON' }));
        continue;
      }
      try {
        write(JSON.stringify(runCommand(engine, c)));
      } catch (e) {
        write(JSON.stringify(errObj(e)));
      }
    }
    return;
  }
  throw Object.assign(
    new Error('usage: node cli.js scan <file.jsonl> <rules.json> | node cli.js exec <rules.json>'),
    { code: 'USAGE' }
  );
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stdout.write(JSON.stringify(errObj(e)) + '\n');
    process.exitCode = e.code === 'USAGE' ? 2 : 1;
  });
}

module.exports = { main, runCommand };
