#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { SampleCache, CacheError } = require('./lib/cache');

const USAGE = `usage: node cli.js <command> [args] [--cache-dir DIR]

commands:
  ingest <sample> [--block-size N] [--capacity BYTES]
  correctRange <sample> <start> <end> (--fill N | --data FILE | --text STR)
  certify <sample> <start> <end> [--out FILE]
  checkCert <sample> <certFile>
  invalidate <sample> <start> <end>
  merge <sample> <certA> <certB> [--out FILE]
  certs <sample>
  info <sample>

errors are reported as JSON on stderr: ERR_STALE / ERR_CRC / ERR_SOURCE / ERR_RANGE
`;

function emitError(code, message) {
  fs.writeSync(2, JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function out(obj) { fs.writeSync(1, JSON.stringify(obj) + '\n'); }

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function readCert(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { emitError('ERR_CRC', `cannot read certificate ${file}: ${e.message}`); }
}

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const cacheDir = flags['cache-dir'];
  const need = (cond, msg) => { if (!cond) emitError('ERR_RANGE', msg); };

  switch (cmd) {
    case 'ingest': {
      need(pos[1], 'usage: ingest <sample> [--block-size N] [--capacity BYTES]');
      const cache = SampleCache.ingest(pos[1], {
        blockSize: flags['block-size'] !== undefined ? Number(flags['block-size']) : undefined,
        capacity: flags.capacity !== undefined ? Number(flags.capacity) : undefined,
        cacheDir,
      });
      out({ ok: true, ...cache.stats() });
      break;
    }
    case 'correctRange': {
      need(pos[1] && pos[2] !== undefined && pos[3] !== undefined,
        'usage: correctRange <sample> <start> <end> (--fill N | --data FILE | --text STR)');
      const start = Number(pos[2]);
      const end = Number(pos[3]);
      let data;
      if (flags.fill !== undefined) data = Buffer.alloc(Math.max(0, end - start), Number(flags.fill) & 0xff);
      else if (flags.data) data = fs.readFileSync(flags.data);
      else if (flags.text !== undefined) data = Buffer.from(String(flags.text), 'utf8');
      else emitError('ERR_RANGE', 'correctRange requires --fill, --data or --text');
      const cache = SampleCache.open(pos[1], { cacheDir });
      out({ ok: true, ...cache.correctRange(start, end, data) });
      break;
    }
    case 'certify': {
      need(pos[1] && pos[2] !== undefined && pos[3] !== undefined,
        'usage: certify <sample> <start> <end> [--out FILE]');
      const cache = SampleCache.open(pos[1], { cacheDir });
      const cert = cache.certify(Number(pos[2]), Number(pos[3]));
      const json = JSON.stringify(cert, null, 2) + '\n';
      if (flags.out) fs.writeFileSync(flags.out, json);
      else fs.writeSync(1, json);
      break;
    }
    case 'checkCert': {
      need(pos[1] && pos[2], 'usage: checkCert <sample> <certFile>');
      const cache = SampleCache.open(pos[1], { cacheDir });
      out(cache.checkCert(readCert(pos[2])));
      break;
    }
    case 'invalidate': {
      need(pos[1] && pos[2] !== undefined && pos[3] !== undefined,
        'usage: invalidate <sample> <start> <end>');
      const cache = SampleCache.open(pos[1], { cacheDir });
      out({ ok: true, ...cache.invalidate(Number(pos[2]), Number(pos[3])) });
      break;
    }
    case 'merge': {
      need(pos[1] && pos[2] && pos[3], 'usage: merge <sample> <certA> <certB> [--out FILE]');
      const cache = SampleCache.open(pos[1], { cacheDir });
      const merged = cache.mergeCerts(readCert(pos[2]), readCert(pos[3]));
      if (!merged) { out({ merged: false, certs: 'kept side by side' }); break; }
      if (flags.out) {
        fs.writeFileSync(flags.out, JSON.stringify(merged, null, 2) + '\n');
        out({ merged: true, out: flags.out });
      } else {
        fs.writeSync(1, JSON.stringify(merged, null, 2) + '\n');
      }
      break;
    }
    case 'certs': {
      need(pos[1], 'usage: certs <sample>');
      out({ certs: SampleCache.open(pos[1], { cacheDir }).listCerts() });
      break;
    }
    case 'info': {
      need(pos[1], 'usage: info <sample>');
      out(SampleCache.open(pos[1], { cacheDir }).stats());
      break;
    }
    default:
      fs.writeSync(2, USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof CacheError) emitError(e.code, e.message);
  emitError('ERR_INTERNAL', e.message);
}
