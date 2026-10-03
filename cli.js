#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PlannerError, PlannerStore, plan, makeCertificate } from './src/index.js';

const DEFAULT_STORE = 'planner-store.json';

function loadStore(path) {
  if (!existsSync(path)) return new PlannerStore();
  return PlannerStore.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function emitPlan(store, version) {
  const result = plan(store.getRawSpec(version));
  return { ok: true, version, plan: result, certificate: makeCertificate(result, version) };
}

// Returns { code, stdout, stderr }. Pure with respect to stdio so it can be
// driven in-process by tests; only the store file is persisted, and only
// after a fully validated, fully planned result exists.
export function run(argv) {
  try {
    const [command, ...rest] = argv;
    const { flags, positional } = parseFlags(rest);

    if (command === 'plan') {
      const specPath = positional[0];
      if (!specPath) throw new PlannerError('E_USAGE', 'usage: node cli.js plan <spec.json> [--store path]');
      const storePath = flags.store ?? DEFAULT_STORE;
      const store = loadStore(storePath);
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      const version = store.addVersion(spec); // throws before any mutation/persist
      const doc = emitPlan(store, version);
      writeFileSync(storePath, JSON.stringify(store.toJSON(), null, 2));
      return { code: 0, stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: '' };
    }

    if (command === 'revise') {
      const storePath = positional[0] ?? DEFAULT_STORE;
      if (!flags.task || flags.cost === undefined || flags.version === undefined) {
        throw new PlannerError('E_USAGE', 'usage: node cli.js revise <store.json> --version N --task NAME --cost X');
      }
      const store = loadStore(storePath);
      const version = store.revise(Number(flags.version), flags.task, Number(flags.cost));
      const doc = emitPlan(store, version);
      writeFileSync(storePath, JSON.stringify(store.toJSON(), null, 2));
      return { code: 0, stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: '' };
    }

    if (command === 'show') {
      const storePath = positional[0] ?? DEFAULT_STORE;
      const store = loadStore(storePath);
      const version = flags.version !== undefined ? Number(flags.version) : store.versionCount;
      const doc = emitPlan(store, version);
      return { code: 0, stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: '' };
    }

    throw new PlannerError('E_USAGE', 'commands: plan <spec.json> [--store p] | revise <store> --version N --task T --cost X | show <store> [--version N]');
  } catch (err) {
    const code = err instanceof PlannerError ? err.code : 'E_INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code, message } })}\n` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
