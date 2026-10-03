import { Engine } from './engine.js';
import { verifyCertificate } from './core.js';

// Build the full report for a parsed scenario { config, events }.
// Shared by the CLI and the tests so both exercise identical logic.
export function buildReport(input, { strategy = 'heap', verify = false } = {}) {
  const engine = new Engine(input.config, { strategy });
  const result = engine.run(input.events ?? []);
  let ok = result.violations.length === 0;
  const out = { ...result };
  if (verify) {
    out.certificateFailures = result.certificates.filter((c) => !verifyCertificate(c)).map((c) => c.slot);
    ok = ok && out.certificateFailures.length === 0;
  }
  out.ok = ok;
  return out;
}
