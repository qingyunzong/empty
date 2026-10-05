import { readFileSync } from 'node:fs';
import { mergeHistories } from './merge.js';
import { InvalidHistory, PendingError, ConflictError } from './errors.js';

export const EXIT = { OK: 0, INVALID_HISTORY: 2, PENDING: 4, CONFLICT: 6 };

export const USAGE = `usage: eco-merge --config <config.json> [--budget N] <history.jsonl> [...more.jsonl]

Merge offline quadrant histories from multiple tablets and decide whether the
concurrent correction history converges to one species abundance matrix.

verdicts (stdout, JSON):
  CONCURRENT_OK       concurrent writes exist but none interfere; merge converges
  LINEARIZABLE_MODEL  all writes are causally ordered; merged matrix equals a legal serialization
  CONFLICT            causal cycle or interfering concurrent writes (exit 6)
  PENDING             cycle-detection budget exhausted; no verdict either way (exit 4)

errors:
  INVALID_HISTORY     malformed history / constraint violation (exit 2)`;

// Returns { code, out, err } so it can be driven in-process by tests.
export function run(argv) {
  const args = [...argv];
  let configPath = null;
  let budget = 1_000_000;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') configPath = args[++i];
    else if (a === '--budget') budget = Number(args[++i]);
    else if (a === '--help' || a === '-h') return { code: EXIT.OK, out: USAGE + '\n', err: '' };
    else if (a.startsWith('--')) return { code: EXIT.INVALID_HISTORY, out: '', err: `unknown flag ${a}\n${USAGE}\n` };
    else files.push(a);
  }
  if (!configPath || files.length === 0 || !Number.isInteger(budget) || budget < 0) {
    return { code: EXIT.INVALID_HISTORY, out: '', err: USAGE + '\n' };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { code: EXIT.INVALID_HISTORY, out: JSON.stringify({ verdict: 'INVALID_HISTORY', error: `config: ${e.message}` }) + '\n', err: '' };
  }
  const inputs = [];
  for (const f of files) {
    try {
      inputs.push({ name: f, text: readFileSync(f, 'utf8') });
    } catch (e) {
      return { code: EXIT.INVALID_HISTORY, out: JSON.stringify({ verdict: 'INVALID_HISTORY', error: `cannot read ${f}: ${e.message}` }) + '\n', err: '' };
    }
  }

  try {
    const result = mergeHistories(config, inputs, { budget });
    return { code: EXIT.OK, out: JSON.stringify(result, null, 2) + '\n', err: '' };
  } catch (e) {
    if (e instanceof InvalidHistory) {
      return { code: EXIT.INVALID_HISTORY, out: JSON.stringify({ verdict: 'INVALID_HISTORY', error: e.message }) + '\n', err: '' };
    }
    if (e instanceof PendingError) {
      return { code: EXIT.PENDING, out: JSON.stringify({ verdict: 'PENDING', error: e.message }) + '\n', err: '' };
    }
    if (e instanceof ConflictError) {
      return { code: EXIT.CONFLICT, out: JSON.stringify({ verdict: 'CONFLICT', error: e.message, ...e.detail }) + '\n', err: '' };
    }
    throw e;
  }
}
