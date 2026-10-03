#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const core = require('./src/core');

function out(line) {
  fs.writeSync(1, line + '\n');
}

function err(line) {
  fs.writeSync(2, line + '\n');
}

function main(argv) {
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      dir: { type: 'string', default: '.' },
      lot: { type: 'string' },
      test: { type: 'string' },
    },
    allowPositionals: false,
  });
  const dir = values.dir;

  switch (command) {
    case 'certify': {
      const { issued, skipped } = core.certify(dir, values.lot);
      for (const c of issued) {
        out(`issued ${c.certId} lot=${c.lotId} conclusion=${c.conclusion} rule=${c.decisiveRule} hash=${c.inputHash.slice(0, 12)}`);
        if (c.counterexample) {
          out(`  counterexample: ${JSON.stringify(c.counterexample)}`);
        }
      }
      for (const id of skipped) out(`up-to-date lot=${id}`);
      return core.EXIT.OK;
    }
    case 'revoke': {
      if (!values.test) throw new core.CertError('revoke requires --test <testId>', core.EXIT.MISSING_TEST);
      const r = core.revoke(dir, values.test);
      if (r.already) {
        out(`test ${r.revoked} already revoked`);
      } else {
        out(`revoked test ${r.revoked}; stale lots: ${r.staleLots.join(', ') || 'none'}`);
      }
      return core.EXIT.OK;
    }
    case 'verify': {
      const r = core.verify(dir);
      out(`verify ok: ${r.checked} certificate(s) checked`);
      return core.EXIT.OK;
    }
    default:
      err('usage: node cli.js <certify|revoke|verify> [--dir DIR] [--lot ID] [--test ID]');
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof core.CertError) {
    err(e.message);
    process.exitCode = e.code;
  } else {
    throw e;
  }
}
