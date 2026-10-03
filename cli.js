#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Session } = require('./src/session');
const { ScanError } = require('./src/scanner');

function errorJson(cmd, e) {
  return { ok: false, cmd, error: e instanceof ScanError ? e.code : 'INTERNAL', message: e.message };
}

function handleCommand(session, c) {
  switch (c.cmd) {
    case 'load': {
      const r = session.load(c.file, c.rules);
      return { ok: true, cmd: 'load', stats: r.stats };
    }
    case 'scan': {
      const r = session.scan();
      return { ok: true, cmd: 'scan', hits: r.hits, proof: r.proof, stats: r.stats };
    }
    case 'patch': {
      const r = session.patch(c.line, c.record);
      return { ok: true, cmd: 'patch', window: r.window, proof: r.proof, hits: r.hits, stats: r.stats };
    }
    case 'verify': {
      const r = session.verify(c.proof);
      return { ok: true, cmd: 'verify', ...r };
    }
    default:
      return { ok: false, cmd: c.cmd, error: 'UNKNOWN_CMD', message: 'expected load|patch|scan|verify' };
  }
}

function runJsonlMode() {
  const input = fs.readFileSync(0, 'utf8');
  const session = new Session();
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    let res;
    let cmdName = null;
    try {
      const c = JSON.parse(line);
      cmdName = c.cmd;
      res = handleCommand(session, c);
    } catch (e) {
      res = errorJson(cmdName, e);
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}

function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd) {
    runJsonlMode();
    return;
  }
  const session = new Session();
  try {
    if (cmd === 'scan') {
      const [file, rules] = args;
      if (!file || !rules) throw new Error('usage: node cli.js scan <file.jsonl> <rules.json>');
      session.load(file, rules);
      const r = session.scan();
      process.stdout.write(JSON.stringify({ ok: true, hits: r.hits, proof: r.proof, stats: r.stats }, null, 2) + '\n');
    } else if (cmd === 'verify') {
      const [file, rules, proofFile] = args;
      if (!file || !rules || !proofFile) throw new Error('usage: node cli.js verify <file.jsonl> <rules.json> <proof.json>');
      session.load(file, rules);
      const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
      const r = session.verify(proof);
      process.stdout.write(JSON.stringify({ ok: true, ...r }, null, 2) + '\n');
    } else {
      process.stderr.write('usage: node cli.js [scan <file.jsonl> <rules.json> | verify <file.jsonl> <rules.json> <proof.json>]\n');
      process.stderr.write('       node cli.js   # JSONL command mode on stdin: load/patch/scan/verify\n');
      process.exit(2);
    }
  } catch (e) {
    process.stdout.write(JSON.stringify(errorJson(cmd, e)) + '\n');
    process.exit(1);
  }
}

main();
