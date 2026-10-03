// High-level pipeline: history versions -> per-version verdicts.

import { buildVersions } from './history.js';
import { checkVersion } from './checker.js';

export function runCheck(compiled, history) {
  const versions = buildVersions(history);
  return versions.map((v) => {
    if (v.missingTarget) {
      return {
        verdict: 'UNKNOWN',
        pending: [],
        danglingPrev: [],
        missingCorrectionTarget: v.correction.corrects,
        events: v.events.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        edges: [],
        commutePairs: [],
        correction: v.correction,
      };
    }
    return { ...checkVersion(v.events, compiled), correction: v.correction };
  });
}
