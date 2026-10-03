'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { JeError } = require('../src/errors');
const { lex } = require('../src/lexer');
const { parse } = require('../src/parser');
const { check } = require('../src/checker');
const { compile } = require('../src/compiler');
const vm = require('../src/vm');
const { Db, recover } = require('../src/db');
const { main } = require('../src/cli');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function compileSrc(src) {
  return compile(check(parse(lex(src))));
}

// Run a program against a fresh db; opts.crashAt simulates a kill after
// that posting is durable on disk but before the index update.
function runProgram(src, events, dbDir, opts = {}) {
  const program = compileSrc(src);
  const db = Db.open(dbDir, { crashAt: opts.crashAt, crashMode: 'throw' });
  db.beginRun(program.periods);
  return vm.run(program, events, db);
}

// Invoke the CLI in-process (the sandbox forbids child processes), capturing
// stdout. Returns { status, error, stdout }.
function cli(argv) {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    main(argv);
    return { status: 0, error: null, stdout: lines.join('\n') + '\n' };
  } catch (err) {
    if (err instanceof JeError) return { status: 1, error: err, stdout: lines.join('\n') + '\n' };
    throw err;
  } finally {
    console.log = origLog;
  }
}

const SIMPLE_JE = `account 1001 "Cash";
account 2001 "Revenue";
period 2025-01 open;
batch SALE in 2025-01 on sale {
  post dr 1001 event.amount cr 2001 event.amount;
}
`;

module.exports = {
  JeError, mkTmp, writeFile, readJson, readLines,
  compileSrc, runProgram, cli, recover, SIMPLE_JE, captureThrow,
};

function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}
