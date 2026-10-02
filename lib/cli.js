#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { ArchiveSystem, ArchiveError, EXIT_ERROR_CODES } = require('./archive');

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    }
  }
  return flags;
}

function loadState(path) {
  return ArchiveSystem.fromJSON(JSON.parse(fs.readFileSync(path, 'utf8')));
}

function saveState(path, sys) {
  fs.writeFileSync(path, JSON.stringify(sys.toJSON(), null, 2));
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function parseQuotas(raw) {
  const quotas = {};
  if (typeof raw === 'string') {
    for (const pair of raw.split(',')) {
      const [name, weight] = pair.split('=');
      quotas[name] = Number(weight);
    }
  }
  return quotas;
}

function main(argv) {
  const [cmd, statePath, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (cmd) {
    case 'init': {
      const sys = new ArchiveSystem({
        bandwidth: flags.bandwidth !== undefined ? Number(flags.bandwidth) : undefined,
        staging: flags.staging !== undefined ? Number(flags.staging) : undefined,
        maxWait: flags['max-wait'] !== undefined ? Number(flags['max-wait']) : undefined,
        quotas: parseQuotas(flags.quota),
      });
      saveState(statePath, sys);
      print({ ok: true, config: sys.config });
      return 0;
    }
    case 'request': {
      const sys = loadState(statePath);
      const obj = sys.request({
        id: flags.id,
        size: Number(flags.size),
        checksum: typeof flags.checksum === 'string' ? flags.checksum : null,
        retention: flags.retention !== undefined ? Number(flags.retention) : 1,
        requester: typeof flags.requester === 'string' ? flags.requester : 'default',
        parent: typeof flags.parent === 'string' ? flags.parent : null,
        locked: Boolean(flags.locked),
      });
      saveState(statePath, sys);
      print({ ok: true, object: obj });
      return 0;
    }
    case 'restore': {
      const sys = loadState(statePath);
      const result = sys.restore({
        ticks: flags.ticks !== undefined ? Number(flags.ticks) : 1,
        failAt: typeof flags['fail-at'] === 'string' ? flags['fail-at'] : null,
      });
      saveState(statePath, sys);
      print(result);
      if (result.aborted) return 1;
      if (result.failures.some((f) => EXIT_ERROR_CODES.has(f.reason))) return 11;
      return 0;
    }
    case 'correct': {
      const sys = loadState(statePath);
      const result = sys.correct(flags.id);
      saveState(statePath, sys);
      print(result);
      return 0;
    }
    case 'evict': {
      const sys = loadState(statePath);
      const result = sys.evict(flags.id, typeof flags.reason === 'string' ? flags.reason : 'manual');
      saveState(statePath, sys);
      print(result);
      return 0;
    }
    case 'verify': {
      const sys = loadState(statePath);
      const report = sys.verify();
      print(report);
      return report.ok ? 0 : 1;
    }
    case 'undo': {
      const sys = loadState(statePath);
      const result = sys.undo(flags.steps !== undefined ? Number(flags.steps) : 1);
      saveState(statePath, sys);
      print(result);
      return 0;
    }
    default:
      throw new ArchiveError('usage', `unknown command ${cmd}; expected init|request|restore|correct|evict|verify|undo`);
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArchiveError) {
      process.stderr.write(JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n');
      process.exitCode = EXIT_ERROR_CODES.has(err.code) ? 11 : 2;
    } else {
      throw err;
    }
  }
}

module.exports = { main };
