#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Writer } = require('./src/writer');
const { Decoder, verifyCertificateFile } = require('./src/decoder');
const { QlinError } = require('./src/errors');

const USAGE = `usage:
  node cli.js init <db> [--block-records N]
  node cli.js add <db> --lot L [--parents a,b] [--op OP] [--verdict V]
  node cli.js seal <db>
  node cli.js ancestors <db> <lot>
  node cli.js descendants <db> <lot>
  node cli.js paths <db> <from> <to>
  node cli.js verify <db> <cert.json>`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

// Returns process exit code. Output goes through out/err writers.
function run(argv, out, err) {
  const [cmd, ...args] = argv;
  const { flags, rest } = parseFlags(args);

  try {
    switch (cmd) {
      case 'init': {
        const [db] = rest;
        if (!db) return usage(err);
        Writer.init(db, { blockRecords: flags['block-records'] ? Number(flags['block-records']) : undefined });
        out(`initialized ${db}`);
        return 0;
      }
      case 'add': {
        const [db] = rest;
        if (!db || !flags.lot) return usage(err);
        const w = new Writer(db);
        const rec = w.add({
          lot: flags.lot,
          parents: flags.parents ? flags.parents.split(',').filter((s) => s) : [],
          op: flags.op || '',
          verdict: flags.verdict || '',
        });
        out(JSON.stringify(rec));
        return 0;
      }
      case 'seal': {
        const [db] = rest;
        if (!db) return usage(err);
        const w = new Writer(db);
        const id = w.seal();
        out(id === null ? 'nothing to seal' : `sealed block ${id}`);
        return 0;
      }
      case 'ancestors':
      case 'descendants': {
        const [db, lot] = rest;
        if (!db || !lot) return usage(err);
        const d = new Decoder(db);
        try {
          out(JSON.stringify(d[cmd](lot), null, 2));
        } finally {
          d.close();
        }
        return 0;
      }
      case 'paths': {
        const [db, from, to] = rest;
        if (!db || !from || !to) return usage(err);
        const d = new Decoder(db);
        try {
          out(JSON.stringify(d.paths(from, to), null, 2));
        } finally {
          d.close();
        }
        return 0;
      }
      case 'verify': {
        const [db, certFile] = rest;
        if (!db || !certFile) return usage(err);
        const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
        verifyCertificateFile(db, cert);
        out('certificate OK');
        return 0;
      }
      default:
        return usage(err);
    }
  } catch (e) {
    if (e instanceof QlinError) {
      err(`error ${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

function usage(err) {
  err(USAGE);
  return 2;
}

if (require.main === module) {
  const code = run(
    process.argv.slice(2),
    (s) => console.log(s),
    (s) => console.error(s),
  );
  process.exit(code);
}

module.exports = { run };
