// Certificate verification: re-runs the full pipeline from the inputs
// embedded in a report and compares the recomputed results.

import { parseDsl } from './parser.js';
import { typeCheck } from './types.js';
import { compileProgram } from './bytecode.js';
import { parseHistory } from './history.js';
import { runCheck } from './checker.js';

export class VerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyError';
  }
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildReport({ rulesSource, historySource, result }) {
  return {
    tool: 'causallint',
    format: 1,
    rules: rulesSource,
    history: historySource,
    verdict: result.verdict,
    versions: result.versions,
  };
}

export function verifyReport(report) {
  if (report === null || typeof report !== 'object') {
    throw new VerifyError('report must be a JSON object');
  }
  for (const f of ['rules', 'history', 'verdict', 'versions']) {
    if (!(f in report)) throw new VerifyError(`report is missing field ${JSON.stringify(f)}`);
  }
  const program = typeCheck(parseDsl(report.rules, '<report rules>'));
  const compiled = compileProgram(program);
  const events = parseHistory(report.history, '<report history>');
  const recomputed = runCheck(events, compiled, '<report history>');

  const mismatches = [];
  if (recomputed.verdict !== report.verdict) {
    mismatches.push(`verdict: report has ${report.verdict}, recomputed ${recomputed.verdict}`);
  }
  if (!Array.isArray(report.versions) || report.versions.length !== recomputed.versions.length) {
    mismatches.push(`versions: report has ${Array.isArray(report.versions) ? report.versions.length : 'none'}, recomputed ${recomputed.versions.length}`);
  } else {
    for (let i = 0; i < recomputed.versions.length; i += 1) {
      if (canonical(report.versions[i]) !== canonical(recomputed.versions[i])) {
        mismatches.push(`version ${i + 1}: certificate mismatch`);
      }
    }
  }
  return { ok: mismatches.length === 0, verdict: recomputed.verdict, mismatches };
}
