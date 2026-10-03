#!/usr/bin/env node
'use strict';

// 批次谱系追溯 CLI：trace / commit / undo / init
// 状态持久化于 JSON 文件，仅使用 Node.js 标准库。

const fs = require('node:fs');
const path = require('node:path');
const genealogy = require(path.join(__dirname, '..', 'lib', 'genealogy.js'));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function loadState(file) {
  if (!fs.existsSync(file)) {
    throw new Error('state file not found: ' + file + ' (run init first)');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const state = genealogy.createState();
  state.version = raw.version || 0;
  state.edges = raw.edges || [];
  state.inspections = raw.inspections || [];
  state.transactions = raw.transactions || [];
  return state;
}

function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

// 执行一条命令，返回结果对象；出错抛出异常。
function run(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const stateFile = args.state || 'state.json';

  switch (command) {
    case 'init': {
      const data = args.data ? JSON.parse(fs.readFileSync(args.data, 'utf8')) : undefined;
      const state = genealogy.createState(data);
      saveState(stateFile, state);
      return { ok: true, state: stateFile, version: state.version };
    }
    case 'trace': {
      if (!args.lot) throw new Error('trace requires --lot <lot>');
      const state = loadState(stateFile);
      return genealogy.certificate(state, args.lot);
    }
    case 'commit': {
      const tx = args.tx
        ? JSON.parse(args.tx)
        : JSON.parse(fs.readFileSync(args['tx-file'], 'utf8'));
      const state = loadState(stateFile);
      const next = genealogy.commit(state, tx);
      saveState(stateFile, next);
      return { ok: true, committed: tx.id, version: next.version };
    }
    case 'undo': {
      const txId = args['tx-id'];
      if (!txId) throw new Error('undo requires --tx-id <id>');
      const state = loadState(stateFile);
      const result = genealogy.undo(state, txId);
      if (result.changed) {
        saveState(stateFile, result.state);
      }
      return { ok: true, undone: txId, changed: result.changed, version: result.state.version };
    }
    default:
      throw new Error('usage: cli.js <init|trace|commit|undo> [--state file] [options]');
  }
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(run(process.argv.slice(2)), null, 2) + '\n');
  } catch (err) {
    process.stderr.write('error: ' + err.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { run };
