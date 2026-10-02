#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DCDB, DBError, canonicalize } from './db.js';

const USAGE = `Usage: dcd [--dir <path>] <command> ...

Commands:
  put <key> <value>     stage a write in the pending draft transaction
  commit                commit the pending transaction, prints new version number
  publish <version>     freeze a version as published, prints its certificate hash
  get --version <n>     print the canonical snapshot at version n
  get --cert <hash>     print the canonical snapshot of a published certificate
  verify --version <n>  verify the certificate of published version n
  verify --cert <hash>  verify a certificate against its stored snapshot

Data directory defaults to $DCDB_DIR or ./.dcdb
Error codes: FROZEN (write touches a published key), NO_VERSION (unknown
version/cert), TAMPER (certificate does not match its snapshot).`;

function parseArgs(argv) {
  const opts = { dir: process.env.DCDB_DIR || '.dcdb', positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--version') opts.version = Number(argv[++i]);
    else if (a === '--cert') opts.cert = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

function pendingFile(dir) {
  return path.join(dir, 'pending.json');
}

function readPending(dir) {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(dir), 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = opts.positional;
  if (!cmd) {
    console.error(USAGE);
    process.exit(2);
  }

  const db = DCDB.open(opts.dir);

  switch (cmd) {
    case 'put': {
      const [key, value] = rest;
      if (key === undefined || value === undefined) throw new DBError('USAGE', 'put <key> <value>');
      const pending = readPending(opts.dir);
      pending[key] = value;
      fs.writeFileSync(pendingFile(opts.dir), JSON.stringify(pending, null, 2) + '\n');
      console.log(`staged ${JSON.stringify(key)} (draft)`);
      break;
    }
    case 'commit': {
      const pending = readPending(opts.dir);
      if (Object.keys(pending).length === 0) throw new DBError('EMPTY_TXN', 'no staged writes to commit');
      const tx = db.begin();
      for (const [k, v] of Object.entries(pending)) tx.put(k, v);
      const version = tx.commit();
      fs.rmSync(pendingFile(opts.dir), { force: true });
      console.log(`committed version ${version}`);
      break;
    }
    case 'publish': {
      const version = Number(rest[0]);
      const rec = db.publish(version);
      console.log(`published version ${rec.version}`);
      console.log(`cert ${rec.cert}`);
      break;
    }
    case 'get': {
      const sel = {};
      if (opts.cert !== undefined) sel.cert = opts.cert;
      else if (opts.version !== undefined) sel.version = opts.version;
      const state = db.get(sel);
      process.stdout.write(canonicalize(state));
      break;
    }
    case 'verify': {
      const sel = {};
      if (opts.cert !== undefined) sel.cert = opts.cert;
      else if (opts.version !== undefined) sel.version = opts.version;
      db.verify(sel);
      console.log('OK');
      break;
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof DBError) {
    console.error(`ERROR ${err.code}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
