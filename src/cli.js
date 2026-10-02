#!/usr/bin/env node
'use strict';
// CLI：trace / commit / undo。状态持久化在 JSON 文件（默认 ./trace-db.json，可用 --db 覆盖）。
const fs = require('node:fs');
const path = require('node:path');
const lineage = require('./lineage');

function parseArgs(argv, env, cwd) {
  const args = [...argv];
  let db = env.TRACE_DB || path.resolve(cwd, 'trace-db.json');
  while (args[0] === '--db') {
    args.shift();
    db = path.resolve(cwd, args.shift());
  }
  const [command, ...rest] = args;
  return { db, command, rest };
}

function loadState(db) {
  if (!fs.existsSync(db)) return lineage.emptyState();
  return JSON.parse(fs.readFileSync(db, 'utf8'));
}

function saveState(db, state) {
  fs.writeFileSync(db, JSON.stringify(state, null, 2) + '\n');
}

function readTx(spec) {
  const text = fs.existsSync(spec) ? fs.readFileSync(spec, 'utf8') : spec;
  return JSON.parse(text);
}

// 返回进程退出码；输出通过 io.stdout/io.stderr 写入，便于测试与真实 CLI 复用。
function run(argv, io = {}, env = process.env, cwd = process.cwd()) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  try {
    const { db, command, rest } = parseArgs(argv, env, cwd);
    const state = loadState(db);
    if (command === 'trace') {
      const lot = rest[0];
      if (!lot) throw new Error('usage: cli.js [--db FILE] trace <lot>');
      stdout(JSON.stringify(lineage.certificate(state, lot), null, 2) + '\n');
    } else if (command === 'commit') {
      if (!rest[0]) throw new Error('usage: cli.js [--db FILE] commit <tx.json|inline-json>');
      const tx = readTx(rest[0]);
      const version = lineage.commit(state, tx);
      saveState(db, state);
      stdout(JSON.stringify({ committed: tx.id, version }) + '\n');
    } else if (command === 'undo') {
      const txId = rest[0];
      if (!txId) throw new Error('usage: cli.js [--db FILE] undo <txId>');
      const result = lineage.undo(state, txId);
      saveState(db, state);
      stdout(JSON.stringify({ undone: txId, ...result }) + '\n');
    } else {
      throw new Error('unknown command: ' + command + ' (expected trace|commit|undo)');
    }
    return 0;
  } catch (err) {
    stderr('error: ' + err.message + '\n');
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
