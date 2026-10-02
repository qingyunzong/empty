#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as engine from './engine.js';

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

// Runs one CLI command and returns {code, stdout, stderr} without exiting,
// so tests can drive the CLI in-process. Errors are JSON with non-zero codes.
export function run(argv, { env = process.env } = {}) {
  let stdout = '';
  let stderr = '';
  const out = (value) => {
    stdout += JSON.stringify(value) + '\n';
  };
  const fail = (code, message, exitCode = 1) => {
    stderr += JSON.stringify({ error: { code, message } }) + '\n';
    return { code: exitCode, stdout, stderr };
  };

  try {
    const { pos, flags } = parseArgs(argv);
    const dir =
      typeof flags.data === 'string' ? flags.data : env.RISKDB_DATA ?? './riskdb-data';
    const command = pos[0];
    const state = engine.openStore(dir);
    switch (command) {
      case 'build-index': {
        const res = engine.buildIndex(state);
        out({ ok: true, command, ...res, index: engine.status(state).index });
        break;
      }
      case 'tx': {
        const raw =
          pos[1] ?? (typeof flags.file === 'string' ? fs.readFileSync(flags.file, 'utf8') : null);
        if (raw === null) throw new engine.DbError('E_BAD_TX', 'tx requires a JSON payload argument');
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new engine.DbError('E_BAD_JSON', 'tx payload is not valid JSON');
        }
        const res = engine.commit(state, payload);
        out({ ok: true, command, ...res });
        break;
      }
      case 'query': {
        let at;
        if (flags.at !== undefined) {
          at = Number(flags.at);
          if (!Number.isInteger(at)) {
            throw new engine.DbError('E_BAD_VERSION', `--at must be an integer, got ${flags.at}`);
          }
        }
        out({ ok: true, command, ...engine.queryByRisk(state, flags.risk, at) });
        break;
      }
      case 'status': {
        out({ ok: true, command, ...engine.status(state) });
        break;
      }
      case 'crash': {
        if (!flags.backfill) throw new engine.DbError('E_BAD_ARGS', 'crash requires --backfill');
        const res = engine.crashBackfill(state);
        return fail(
          'E_SIMULATED_CRASH',
          `simulated crash during backfill at cursor ${res.cursor}/${res.total}, before watermark`,
          2,
        );
      }
      default:
        return fail(
          'E_USAGE',
          'usage: cli.js [--data DIR] <build-index|tx JSON|query --risk R [--at V]|status|crash --backfill>',
        );
    }
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (e instanceof engine.DbError) return fail(e.code, e.message);
    return fail('E_INTERNAL', String(e?.message ?? e));
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
