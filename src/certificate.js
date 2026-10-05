import { createHash } from 'node:crypto';
import { validateInput } from './reconcile.js';
import { minimize } from './minimize.js';
import { stableStringify } from './stable-json.js';

export function buildCertificate(input) {
  const { expected, actual } = validateInput(input);
  const result = minimize(expected, actual);

  const replayPayload = {
    diffs: result.diffs,
    minimal: {
      expected: result.minimalExpected,
      actual: result.minimalActual,
    },
    totalImpact: result.totalImpact,
  };
  const replayHash =
    'sha256:' + createHash('sha256').update(stableStringify(replayPayload)).digest('hex');

  return {
    version: 1,
    balanced: result.balanced,
    algorithm: result.algorithm,
    diffs: result.diffs,
    totalImpact: result.totalImpact,
    minimal: replayPayload.minimal,
    replayHash,
  };
}
