#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store');
const { RecallError } = require('../src/errors');

const STATE_FILE = process.env.RECALL_STATE || path.join(process.cwd(), 'data', 'state.json');

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Store.deserialize(raw);
  } catch {
    return new Store();
  }
}

function saveState(store) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(store.serialize()));
}

function parseQuery(args) {
  const q = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phrase') {
      q.phrase = [args[i + 1], args[i + 2]];
      i += 2;
    } else if (args[i] === '--window') {
      q.window = Number(args[++i]);
    } else if (args[i] === '--epoch' || args[i] === '--at-epoch') {
      q._epoch = Number(args[++i]);
    } else if (args[i] === '--force') {
      q._force = true;
    } else if (args[i] === '--cert') {
      q._cert = args[++i];
    }
  }
  return q;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = loadState();
  const args = parseQuery(rest);

  switch (cmd) {
    case 'load': {
      const file = rest.find((a) => !a.startsWith('--'));
      if (!file) throw new RecallError('E_USAGE', 'load requires a JSON file of records');
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      const res = store.load(records);
      saveState(store);
      out(res);
      break;
    }
    case 'delete-batch': {
      const batch = rest.find((a) => !a.startsWith('--'));
      const res = store.deleteBatch(batch);
      saveState(store);
      out(res);
      break;
    }
    case 'recall': {
      const res = store.recall(args, { force: args._force });
      saveState(store);
      out(res);
      break;
    }
    case 'revoke': {
      const res = store.revoke(args, { epoch: args._epoch });
      saveState(store);
      out(res);
      break;
    }
    case 'prove': {
      const cert = JSON.parse(fs.readFileSync(args._cert || rest.find((a) => !a.startsWith('--')), 'utf8'));
      const res = store.prove(cert, { atEpoch: args._epoch });
      out(res);
      break;
    }
    case 'audit': {
      out(store.audit());
      break;
    }
    default:
      process.stderr.write('usage: recall.js <load|recall|revoke|prove|audit|delete-batch> [args]\n');
      process.exitCode = 2;
  }
}

try {
  main();
} catch (err) {
  if (err instanceof RecallError) {
    process.stderr.write(JSON.stringify({ error: err.code, message: err.message }) + '\n');
    process.exitCode = 1;
  } else {
    throw err;
  }
}
