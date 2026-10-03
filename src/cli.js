#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { TrackEngine } = require('./tracker');

function usage() {
  process.stderr.write('usage: node src/cli.js tracks --in <events.jsonl> [--out <actions.jsonl>]\n');
}

function runTracks(inFile) {
  const engine = new TrackEngine();
  const actions = [];
  const lines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/);
  let lineno = 0;
  for (const line of lines) {
    lineno++;
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      actions.push({ type: 'MALFORMED', reason: `invalid JSON at line ${lineno}` });
      continue;
    }
    actions.push(...engine.process(event));
  }
  actions.push(...engine.finish());
  return actions.length ? actions.map((a) => JSON.stringify(a)).join('\n') + '\n' : '';
}

function main(argv, write = (text) => process.stdout.write(text)) {
  const args = argv.slice(2);
  const command = args[0];
  if (command !== 'tracks') {
    usage();
    return 1;
  }
  let inFile = null;
  let outFile = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--in') inFile = args[++i];
    else if (args[i] === '--out') outFile = args[++i];
    else {
      usage();
      return 1;
    }
  }
  if (!inFile) {
    usage();
    return 1;
  }
  const text = runTracks(inFile);
  if (outFile) fs.writeFileSync(outFile, text);
  else write(text);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, runTracks };
