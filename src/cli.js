'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TzRegistry } = require('./registry');
const { ReconEngine } = require('./engine');
const { ReconError } = require('./errors');
const { utcToLocal, localToUtc } = require('./convert');
const { parseUtcIso, formatUtc } = require('./time');

const USAGE = `usage:
  node bin/cli.js reconcile <input.json>   run reconciliation, print JSON result
  node bin/cli.js convert <input.json>     run ad-hoc conversions in input.conversions
`;

function buildRegistry(spec) {
  const registry = new TzRegistry();
  for (const purpose of ['txn', 'settlement', 'fee']) {
    for (const raw of (spec.tables && spec.tables[purpose]) || []) {
      registry.register(purpose, raw);
    }
  }
  return registry;
}

// In-process CLI entry. Returns {code, stdout, stderr}; never exits.
function runCli(argv, cwd = process.cwd()) {
  const [cmd, file] = argv;
  if (!cmd || !file || !['reconcile', 'convert'].includes(cmd)) {
    return { code: 2, stdout: '', stderr: USAGE };
  }
  try {
    const input = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
    const registry = buildRegistry(input);

    if (cmd === 'reconcile') {
      const engine = new ReconEngine(registry);
      const result = engine.reconcile(input, { finalize: !!input.finalize });
      return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
    }

    const evidence = [];
    const out = (input.conversions || []).map((c) => {
      const table = registry.get(c.purpose, c.version);
      if (c.kind === 'utc2local') {
        const zone = table.zones.get(c.zone);
        const r = utcToLocal(table, c.zone, parseUtcIso(c.utc, zone && zone.leapMap));
        return { ...c, local: r.iso, day: r.day, offsetMinutes: r.offsetMinutes };
      }
      if (c.kind === 'local2utc') {
        const r = localToUtc(table, c.zone, c.local, c.policy || input.policy || 'strict', evidence);
        return { ...c, utc: formatUtc(r.utcMs), resolution: r.resolution };
      }
      throw new ReconError('E_POLICY', `unknown conversion kind ${c.kind}`);
    });
    return { code: 0, stdout: JSON.stringify({ results: out, evidence }, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const payload = err instanceof ReconError
      ? { error: err.code, message: err.message, details: err.details || null }
      : { error: 'E_INTERNAL', message: String((err && err.message) || err) };
    return { code: 1, stdout: JSON.stringify(payload) + '\n', stderr: '' };
  }
}

module.exports = { runCli, USAGE };
