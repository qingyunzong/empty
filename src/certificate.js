// Verifiable certificate: commits to the exact inputs (hashes), the rule
// versions, the merged settlement intervals, and every boundary hit, so a
// third party can replay the computation and check the results bit-for-bit.
import { hashObject } from './canon.js';
import { createState, applyFlows, computeNets, computeMergedIntervals } from './settle.js';

export function hashInputs({ tzdbRaw, calendarsRaw }) {
  return {
    tzdbHash: hashObject(tzdbRaw),
    calendarsHash: hashObject(calendarsRaw),
  };
}

export function buildReport({ tzTable, calendars, state, inputHashes, affectedDays }) {
  const nets = computeNets(state);
  const pending = state.pending;
  const intervals = computeMergedIntervals(tzTable, calendars, state);
  const calendarVersions = {};
  for (const [id, cal] of [...calendars.entries()].sort()) calendarVersions[id] = cal.version;
  const certificate = {
    scheme: 'clearing-daycut/v1',
    ruleVersion: `tzdb=${tzTable.version} calendars=${JSON.stringify(calendarVersions)}`,
    inputHash: hashObject({
      tzdbHash: inputHashes.tzdbHash,
      calendarsHash: inputHashes.calendarsHash,
      flowsChain: state.flowsChain,
    }),
    flowsChain: state.flowsChain,
    lastSeq: state.lastSeq,
    intervals,
    boundaryHits: state.boundaryHits,
    affectedDays,
    resultsHash: hashObject({ nets, pending }),
  };
  return { certificate, nets, pending, boundaryHits: state.boundaryHits, affectedDays };
}

// Deterministic replay of the whole flow history from scratch.
export function replay({ tzTable, calendars, flows, inputHashes }) {
  const state = createState();
  const { affectedDays } = applyFlows({ tzTable, calendars, flows, state });
  return buildReport({ tzTable, calendars, state, inputHashes, affectedDays });
}

// Compare a stored report against a fresh replay; returns list of mismatches.
export function verifyReport(storedReport, replayedReport) {
  const mismatches = [];
  const check = (label, a, b) => {
    if (hashObject(a) !== hashObject(b)) mismatches.push(label);
  };
  check('certificate.inputHash', storedReport.certificate.inputHash, replayedReport.certificate.inputHash);
  check('certificate.ruleVersion', storedReport.certificate.ruleVersion, replayedReport.certificate.ruleVersion);
  check('certificate.intervals', storedReport.certificate.intervals, replayedReport.certificate.intervals);
  check('certificate.boundaryHits', storedReport.certificate.boundaryHits, replayedReport.certificate.boundaryHits);
  check('certificate.resultsHash', storedReport.certificate.resultsHash, replayedReport.certificate.resultsHash);
  check('nets', storedReport.nets, replayedReport.nets);
  check('pending', storedReport.pending, replayedReport.pending);
  return mismatches;
}
