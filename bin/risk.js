#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { RuleStore } from '../src/store.js';
import { RiskError, E } from '../src/errors.js';

const USAGE = `usage:
  risk check <rules.rsk...>
  risk eval <rules.rsk...> <events.jsonl> [--explain] [--version N]`;

function loadStore(ruleFiles) {
  const store = new RuleStore();
  for (const f of ruleFiles) store.loadSource(readFileSync(f, 'utf8'));
  return store;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') {
    const files = rest.filter((a) => !a.startsWith('--'));
    if (!files.length) throw E('E_PARSE', 'check: no rule files given');
    const store = loadStore(files);
    console.log(`OK ${files.join(', ')} (versions: ${store.versions.map((v) => v.version).join(', ')})`);
    return 0;
  }
  if (cmd === 'eval') {
    const explain = rest.includes('--explain');
    let version = null;
    const vi = rest.indexOf('--version');
    if (vi !== -1) {
      version = Number(rest[vi + 1]);
      if (!Number.isInteger(version)) throw E('E_VERSION', `--version needs an integer, got '${rest[vi + 1]}'`);
    }
    const files = rest.filter((a, i) => !a.startsWith('--') && (vi === -1 || i !== vi + 1));
    const eventsFile = files.find((f) => f.endsWith('.jsonl'));
    const ruleFiles = files.filter((f) => f !== eventsFile);
    if (!eventsFile || !ruleFiles.length)
      throw E('E_PARSE', 'eval: need <rules.rsk...> <events.jsonl>');
    const store = loadStore(ruleFiles);
    const lines = readFileSync(eventsFile, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const event = JSON.parse(line);
      const r = store.evaluate(event, version != null ? { version } : {});
      const out = {
        id: event.id, version: r.version, decision: r.decision,
        outcome: r.outcome, matched: r.matched,
      };
      if (explain) {
        const rv = store.versions.find((v) => v.version === r.version);
        out.explain = { fired: r.fired, overrides: rv.overrideLog };
      }
      console.log(JSON.stringify(out));
    }
    return 0;
  }
  console.error(USAGE);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof RiskError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
