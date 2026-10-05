#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { encode, appendRecords, Decoder, verifyCertificate, QGError } = require('../src/index');

const USAGE = `qg - offline quality genealogy CLI

Commands:
  encode     --records R.json --data D.qg --manifest M.json --index I.json [--blockSize N]
  append     --records R.json --data D.qg --manifest M.json --index I.json [--blockSize N]
  ancestors  --data D.qg --manifest M.json --index I.json --lot LOT
  descendants --data D.qg --manifest M.json --index I.json --lot LOT
  paths      --data D.qg --manifest M.json --index I.json --from LOT --to LOT [--certs OUT.json]
  verify     --data D.qg --manifest M.json --index I.json --cert CERT.json

Records file: JSON array of {"lot","parents":[],"op","result"}.
Exit code 0 on success; 1 with an error code (E_CRC, E_INDEX, ...) on failure.`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new QGError('E_USAGE', `unexpected argument "${a}"`);
    opts[a.slice(2)] = argv[++i];
  }
  return opts;
}

function need(opts, ...keys) {
  for (const k of keys) {
    if (opts[k] === undefined) throw new QGError('E_USAGE', `missing --${k}`);
  }
}

function pathsOpts(opts) {
  return { dataPath: opts.data, manifestPath: opts.manifest, indexPath: opts.index };
}

// Runs one CLI invocation. `io.out`/`io.err` receive lines of output;
// returns the process exit code. Exported for in-process testing.
function run(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    io.out(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const opts = parseArgs(rest);
    const blockSize = opts.blockSize !== undefined ? Number(opts.blockSize) : undefined;

    switch (cmd) {
      case 'encode':
      case 'append': {
        need(opts, 'records', 'data', 'manifest', 'index');
        const records = JSON.parse(fs.readFileSync(opts.records, 'utf8'));
        const fn = cmd === 'encode' ? encode : appendRecords;
        const res = fn({ records, ...pathsOpts(opts), blockSize });
        io.out(JSON.stringify(res));
        return 0;
      }
      case 'ancestors':
      case 'descendants': {
        need(opts, 'data', 'manifest', 'index', 'lot');
        const dec = new Decoder(pathsOpts(opts));
        try {
          io.out(JSON.stringify({ lots: dec[cmd](opts.lot) }));
        } finally {
          dec.close();
        }
        return 0;
      }
      case 'paths': {
        need(opts, 'data', 'manifest', 'index', 'from', 'to');
        const dec = new Decoder(pathsOpts(opts));
        try {
          const res = dec.pathsWithCertificates(opts.from, opts.to);
          if (opts.certs) fs.writeFileSync(opts.certs, JSON.stringify(res.certificates, null, 2));
          io.out(JSON.stringify(res));
        } finally {
          dec.close();
        }
        return 0;
      }
      case 'verify': {
        need(opts, 'data', 'manifest', 'index', 'cert');
        const cert = JSON.parse(fs.readFileSync(opts.cert, 'utf8'));
        io.out(JSON.stringify(verifyCertificate(cert, pathsOpts(opts))));
        return 0;
      }
      default:
        throw new QGError('E_USAGE', `unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof QGError) {
      io.err(`${err.code}: ${err.message}`);
    } else {
      io.err(`E_INTERNAL: ${err.message}`);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
