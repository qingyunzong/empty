// CLI logic, separated from process I/O so it can be tested in-process.

import { normalizeInstance } from './schema.mjs';
import { solveNormalized } from './solver.mjs';
import { buildUnsatCertificate } from './certificate.mjs';

// Returns { code, stdout, stderr }. Exit codes: 0 = solved
// (FEASIBLE/UNSAT/UNKNOWN), 2 = schema/IO error.
export function runCli(args, { readStdin, readFile }) {
  const file = args.find((a) => !a.startsWith('--'));
  const wantAll = args.includes('--all');

  let text;
  try {
    text = !file || file === '-' ? readStdin() : readFile(file);
  } catch (e) {
    return { code: 2, stdout: '', stderr: `ERR_INPUT: ${e.message}\n` };
  }
  if (text === undefined) {
    return { code: 2, stdout: '', stderr: 'ERR_INPUT: no input provided\n' };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { code: 2, stdout: '', stderr: `ERR_SCHEMA: invalid JSON: ${e.message}\n` };
  }

  const v = normalizeInstance(raw);
  if (!v.ok) {
    return { code: 2, stdout: '', stderr: `ERR_SCHEMA: ${v.error}\n` };
  }

  const res = solveNormalized(v.instance);
  const out = { status: res.status };
  if (res.status === 'FEASIBLE') {
    out.objective = res.objective;
    out.schedule = res.schedule;
    out.ties = res.schedules.length;
    if (wantAll) out.schedules = res.schedules;
  } else if (res.status === 'UNSAT') {
    out.minEnergy = res.minEnergy;
    out.certificate = buildUnsatCertificate(v.instance);
  } else {
    out.reason = res.reason;
  }
  return { code: 0, stdout: `${JSON.stringify(out, null, 2)}\n`, stderr: '' };
}
