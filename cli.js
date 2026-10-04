#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SampleCache, CacheError, mergeCertificates } = require('./lib');

const DEFAULT_DIR = '.sample-cache';
const DEFAULT_CAPACITY = 8 * 1024 * 1024;

const USAGE = [
    'usage:',
    '  node cli.js ingest <sample> <source> [--chunk N] [--capacity N] [--dir D]',
    '  node cli.js correctRange <sample> <start> <end> [--source P] [--dir D]',
    '  node cli.js certify <sample> <start> <end> [--out FILE] [--dir D]',
    '  node cli.js checkCert <sample> <certFile> [--dir D]',
    '  node cli.js invalidate <sample> [start end] [--dir D]',
    '  node cli.js merge <certFile...>',
    '',
].join('\n');

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      i += 1;
      if (i >= argv.length) throw new UsageError(`missing value for --${name}`);
      flags[name] = argv[i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function parseIntValue(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new CacheError('ERR_RANGE', `invalid ${name}: ${value}`);
  return n;
}

function checkSampleId(id) {
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new CacheError('ERR_RANGE', `invalid sample id: ${id}`);
  }
}

function blockFile(dir, id, idx) {
  return path.join(dir, 'blocks', `${encodeURIComponent(id)}.${idx}.bin`);
}

function loadCache(dir, capacityOverride) {
  const cache = new SampleCache({ capacity: capacityOverride ?? DEFAULT_CAPACITY });
  const stateFile = path.join(dir, 'state.json');
  if (!fs.existsSync(stateFile)) return cache;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (capacityOverride === undefined) cache.capacity = state.capacity;
  for (const meta of state.samples) {
    cache.samples.set(meta.id, meta);
  }
  for (const [id, idx] of state.lru) {
    const file = blockFile(dir, id, idx);
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file);
      cache.cache.set(`${id}:${idx}`, { data, bytes: data.length });
      cache.usedBytes += data.length;
    }
  }
  return cache;
}

function saveCache(dir, cache) {
  fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
  const lru = [];
  const keep = new Set();
  for (const key of cache.cache.keys()) {
    const sep = key.lastIndexOf(':');
    const id = key.slice(0, sep);
    const idx = Number(key.slice(sep + 1));
    lru.push([id, idx]);
    keep.add(blockFile(dir, id, idx));
    fs.writeFileSync(blockFile(dir, id, idx), cache.cache.get(key).data);
  }
  for (const entry of fs.readdirSync(path.join(dir, 'blocks'))) {
    const file = path.join(dir, 'blocks', entry);
    if (!keep.has(file)) fs.rmSync(file);
  }
  const state = {
    capacity: cache.capacity,
    samples: [...cache.samples.values()],
    lru,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const [cmd, ...rest] = argv;
  try {
    const { positional, flags } = parseArgs(rest);
    const dir = flags.dir || DEFAULT_DIR;
    const capacityOverride = flags.capacity !== undefined
      ? parseIntValue(flags.capacity, 'capacity') : undefined;

    if (!cmd) throw new UsageError('missing command');

    if (cmd === 'merge') {
      const certs = positional.map((file) => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
          throw new CacheError('ERR_CRC', `cannot parse certificate ${file}: ${err.message}`);
        }
      });
      io.stdout(`${JSON.stringify(mergeCertificates(certs), null, 2)}\n`);
      return 0;
    }

    const cache = loadCache(dir, capacityOverride);

    if (cmd === 'ingest') {
      const [id, source] = positional;
      checkSampleId(id);
      if (!source) throw new UsageError('ingest requires <sample> <source>');
      const chunkSize = flags.chunk !== undefined ? parseIntValue(flags.chunk, 'chunk') : 4096;
      const info = cache.ingest(id, source, { chunkSize });
      saveCache(dir, cache);
      io.stdout(`${JSON.stringify(info)}\n`);
    } else if (cmd === 'correctRange') {
      const [id, start, end] = positional;
      checkSampleId(id);
      if (start === undefined || end === undefined) {
        throw new UsageError('correctRange requires <sample> <start> <end>');
      }
      const info = cache.correctRange(
        id,
        parseIntValue(start, 'start'),
        parseIntValue(end, 'end'),
        { sourcePath: flags.source },
      );
      saveCache(dir, cache);
      io.stdout(`${JSON.stringify(info)}\n`);
    } else if (cmd === 'certify') {
      const [id, start, end] = positional;
      checkSampleId(id);
      if (start === undefined || end === undefined) {
        throw new UsageError('certify requires <sample> <start> <end>');
      }
      const cert = cache.certify(id, parseIntValue(start, 'start'), parseIntValue(end, 'end'));
      saveCache(dir, cache);
      const out = `${JSON.stringify(cert, null, 2)}\n`;
      if (flags.out) {
        fs.writeFileSync(flags.out, out);
        io.stdout(`${JSON.stringify({ written: flags.out })}\n`);
      } else {
        io.stdout(out);
      }
    } else if (cmd === 'checkCert') {
      const [id, certFile] = positional;
      checkSampleId(id);
      if (!certFile) throw new UsageError('checkCert requires <sample> <certFile>');
      let cert;
      try {
        cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
      } catch (err) {
        throw new CacheError('ERR_CRC', `cannot parse certificate: ${err.message}`);
      }
      const result = cache.checkCert(id, cert);
      saveCache(dir, cache);
      io.stdout(`${JSON.stringify(result)}\n`);
    } else if (cmd === 'invalidate') {
      const [id, start, end] = positional;
      checkSampleId(id);
      const info = cache.invalidate(
        id,
        start !== undefined ? parseIntValue(start, 'start') : undefined,
        end !== undefined ? parseIntValue(end, 'end') : undefined,
      );
      saveCache(dir, cache);
      io.stdout(`${JSON.stringify(info)}\n`);
    } else {
      throw new UsageError(`unknown command: ${cmd}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${err.message}\n${USAGE}\n`);
      return 2;
    }
    if (err instanceof CacheError) {
      io.stderr(`${JSON.stringify({ error: err.code, message: err.message })}\n`);
      return 1;
    }
    io.stderr(`${JSON.stringify({ error: 'ERR_INTERNAL', message: err.message })}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
