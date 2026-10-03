'use strict';

const fs = require('fs');
const { JeError } = require('./errors');
const { lex } = require('./lexer');
const { parse } = require('./parser');
const { check } = require('./checker');
const { compile } = require('./compiler');
const vm = require('./vm');
const { Db, recover } = require('./db');

const USAGE = `usage:
  je run <batch.je> <events.json> --db <dir>
  je recover --db <dir>`;

function parseArgs(argv) {
  const positional = [];
  let db = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') {
      i += 1;
      db = argv[i];
      if (!db) throw new JeError('E_USAGE', '--db requires a directory');
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, db };
}

function cmdRun(positional, dbDir) {
  if (positional.length !== 2 || !dbDir) throw new JeError('E_USAGE', USAGE);
  const [jeFile, eventsFile] = positional;
  const src = fs.readFileSync(jeFile, 'utf8');
  const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
  if (!Array.isArray(events)) throw new JeError('E_EVENT', 'events file must be a JSON array');

  const program = compile(check(parse(lex(src))));
  const db = Db.open(dbDir);
  db.beginRun(program.periods);
  const { batches } = vm.run(program, events, db);
  for (const id of batches) console.log(`POSTED ${id}`);
  console.log(`OK run: ${batches.length} batch(es), ${db.nextSeq - 1} posting(s), db=${dbDir}`);
}

function cmdRecover(positional, dbDir) {
  if (positional.length !== 0 || !dbDir) throw new JeError('E_USAGE', USAGE);
  const report = recover(dbDir);
  for (const seq of report.replayed) console.log(`REPLAYED posting seq=${seq}`);
  for (const id of Object.keys(report.batches).sort()) {
    console.log(`BATCH ${id} ${report.batches[id]}`);
  }
  console.log(`OK recover: replayed ${report.replayed.length} posting(s), lastSeq=${report.lastSeq}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { positional, db } = parseArgs(rest);
  if (cmd === 'run') cmdRun(positional, db);
  else if (cmd === 'recover') cmdRecover(positional, db);
  else throw new JeError('E_USAGE', USAGE);
}

module.exports = { main };
