#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Engine, formatExplain } from '../src/engine.js';
import { RiskError } from '../src/errors.js';

const USAGE = `usage:
  risk check <rules.rsk>                 compile rules, report versions and overrides
  risk eval <rules.rsk> <events.jsonl> [--explain]
                                         evaluate events; one JSON decision per line,
                                         or a human-readable trace with --explain`;

function cmdCheck(files) {
  const engine = new Engine();
  const loaded = engine.loadSource(readFileSync(files[0], 'utf8'));
  for (const v of loaded) {
    console.log(`version ${v.version}: since=${new Date(v.since).toISOString()} rules=${v.rules.length}`);
    for (const o of v.overrides) {
      console.log(`  override ${o.scope}: threshold ${o.name} ${o.type} ${o.outer} -> ${o.inner} (tightened)`);
    }
  }
  console.log('OK');
}

function cmdEval(files, flags) {
  const explain = flags.has('--explain');
  const engine = new Engine();
  engine.loadSource(readFileSync(files[0], 'utf8'));
  const lines = readFileSync(files[1], 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  lines.forEach((line, idx) => {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new RiskError('E_EVENT', `events file line ${idx + 1}: invalid JSON`);
    }
    const r = engine.evaluate(raw);
    if (explain) {
      console.log(formatExplain(r));
    } else {
      console.log(
        JSON.stringify({
          id: r.id,
          time: r.time,
          version: r.version,
          decision: r.decision,
          rules: r.strictest.map((h) => `${h.path}/${h.rule}`),
        }),
      );
    }
  });
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const files = rest.filter((a) => !a.startsWith('--'));
  if (cmd === 'check' && files.length === 1) return cmdCheck(files);
  if (cmd === 'eval' && files.length === 2) return cmdEval(files, flags);
  console.error(USAGE);
  process.exit(64);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof RiskError) {
    console.error(`${e.code}: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
