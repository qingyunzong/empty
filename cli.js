#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Archive, ArchiveError, EXIT_DATA_ERR } = require('./src/archive');

const DATA_ERR_CODES = new Set(['CHECKSUM', 'DISK_FULL', 'CYCLE']);

function parse(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        flags[key] = rest[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

function num(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ArchiveError('BAD_REQUEST', `not a number: ${value}`);
  return n;
}

function main(argv) {
  const { command, flags } = parse(argv);
  const dir = flags.dir || '.archive';
  const file = path.join(dir, 'state.json');

  let archive;
  if (fs.existsSync(file)) {
    archive = Archive.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else {
    archive = new Archive({
      stagingCapacity: num(flags.capacity, 1024),
      bandwidthPerTick: num(flags.bandwidth, 16),
      waitCap: num(flags['wait-cap'], 8),
    });
  }

  let result;
  let exitCode = 0;
  switch (command) {
    case 'request':
      result = archive.request({
        id: flags.id,
        size: num(flags.size),
        retention: num(flags.retention, 0),
        requester: flags.requester,
        quota: num(flags.quota, 1),
        checksum: flags.checksum === true ? undefined : flags.checksum,
        data: flags.data === true ? undefined : flags.data,
        parent: flags.parent === true ? null : (flags.parent ?? null),
        locked: flags.locked === true,
      });
      break;
    case 'restore': {
      result = archive.restore({ failAt: flags['fail-at'] === true ? null : flags['fail-at'] });
      if (result.failures.some((f) => f.reason === 'disk-full')) exitCode = EXIT_DATA_ERR;
      break;
    }
    case 'correct':
      result = archive.correct(flags.id, flags.checksum);
      break;
    case 'evict':
      result = archive.evict(flags.id);
      break;
    case 'verify':
      result = archive.verify();
      if (!result.ok) exitCode = EXIT_DATA_ERR;
      break;
    case 'undo':
      result = archive.undo(num(flags.generations, 1));
      break;
    default:
      throw new ArchiveError('BAD_REQUEST', `unknown command: ${command}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(archive.toJSON()));
  return { result, exitCode };
}

function runCli(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  try {
    const { result, exitCode } = main(argv);
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return exitCode;
  } catch (err) {
    const code = err instanceof ArchiveError && DATA_ERR_CODES.has(err.code) ? EXIT_DATA_ERR : 1;
    stderr(`${JSON.stringify({ error: err.message, code: err.code || 'ERROR' })}\n`);
    return code;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}

module.exports = { runCli };
