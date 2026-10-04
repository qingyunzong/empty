import { normalizeConfig } from './model.js';
import { Simulation } from './simulator.js';
import { buildCertificate } from './certificate.js';
import { minimizeOverflowPrefix } from './minimize.js';

// Main entry point. Runs the deterministic simulation for the given
// seed/policy, then:
//   - any violation          -> status 'VIOLATION' with firstViolation
//                               (plus a minimal overflowing arrival prefix
//                               when the violation is a buffer overflow)
//   - no violation           -> finite-horizon coverage certificate;
//                               'SAFE' only when the certificate covers the
//                               whole reachable state space within the
//                               horizon and found no violation; otherwise
//                               'UNKNOWN' (UNKNOWN is never reported as SAFE)
export function simulateLine(config) {
  const norm = normalizeConfig(config);
  const sim = new Simulation(norm);
  const run = sim.run();
  if (run.firstViolation) {
    const result = {
      status: 'VIOLATION',
      trace: run.trace,
      firstViolation: run.firstViolation,
      certificate: null,
      minimalPrefix: null,
    };
    if (run.firstViolation.type === 'bufferOverflow') {
      result.minimalPrefix = minimizeOverflowPrefix(norm);
    }
    return result;
  }
  const certificate = buildCertificate(norm);
  const safe = certificate.covered && certificate.violations.length === 0;
  return {
    status: safe ? 'SAFE' : 'UNKNOWN',
    trace: run.trace,
    firstViolation: null,
    certificate,
    minimalPrefix: null,
  };
}

export { normalizeConfig } from './model.js';
export { Simulation } from './simulator.js';
export { buildCertificate } from './certificate.js';
export { minimizeOverflowPrefix } from './minimize.js';
export { IncrementalSimulation } from './incremental.js';
export { generateArrivals, mulberry32 } from './prng.js';
export { SimError, ERR_DOMAIN, ERR_CYCLE } from './errors.js';
