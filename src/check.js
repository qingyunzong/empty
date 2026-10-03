'use strict';

const { prepareFlow, MAX_LOG, MAX_K } = require('./flow');
const { simulate } = require('./automata');
const { computeRepairs } = require('./repair');
const { canonicalEvent } = require('./events');
const { FlowError } = require('./errors');

function semanticReasons(rawEvents, events) {
  const reasons = [];
  const unknownIdx = events.findIndex((e) => e === null);
  if (unknownIdx >= 0) {
    reasons.push({ code: 'UNKNOWN_EVENT', index: unknownIdx, event: rawEvents[unknownIdx] });
  }
  let posted = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i] === 'post') posted += 1;
    else if (events[i] === 'reverse') {
      if (posted === 0) {
        reasons.push({ code: 'REVERSAL_WITHOUT_POSTING', index: i });
        break;
      }
      posted -= 1;
    }
  }
  return reasons;
}

function checkPrepared(prepared, rawEvents, { K = MAX_K } = {}) {
  const k = Math.min(K, MAX_K);
  if (rawEvents.length > MAX_LOG) {
    throw new FlowError(
      'LOG_TOO_LONG',
      `log has ${rawEvents.length} events, limit is ${MAX_LOG}`,
    );
  }
  const { dfa, alphabet } = prepared;
  const events = rawEvents.map(canonicalEvent);
  const reasons = semanticReasons(rawEvents, events);
  const sim = simulate(dfa, events);
  const accept = sim.accepted && reasons.length === 0;

  const witness = { accepted: sim.accepted, states: sim.states, events: rawEvents };
  if (sim.failIndex >= 0) {
    witness.failIndex = sim.failIndex;
    witness.event = rawEvents[sim.failIndex];
  }

  const result = { accept, witness, reasons, repairs: [], repairError: null };
  if (!accept && !sim.accepted) {
    const repairs = computeRepairs(dfa, alphabet, events, k);
    if (repairs.error) result.repairError = repairs.error;
    else result.repairs = repairs.plans;
  }
  return result;
}

function checkLog(source, rawEvents, opts) {
  return checkPrepared(prepareFlow(source), rawEvents, opts);
}

module.exports = { checkLog, checkPrepared };
