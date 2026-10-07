import { counterTotal, downtimeTotal, pendingHolds } from './state.js';

// OEE = available * performance * quality
//   available   = runTime / plannedTime, runTime = plannedTime - merged downtime
//   performance = produced / (idealRate * runTime)
//   quality     = (produced - rejected) / produced, rejected clamped to produced
export function computeOee(state, { plannedTime, idealRate, windowStart, windowEnd }) {
  if (!(plannedTime > 0)) throw new Error('plannedTime must be > 0');
  if (!(idealRate > 0)) throw new Error('idealRate must be > 0');
  const produced = counterTotal(state, 'produced');
  const rejectedRaw = counterTotal(state, 'rejected');
  const rejected = Math.min(Math.max(rejectedRaw, 0), Math.max(produced, 0)); // rejects never exceed production
  const downtime = downtimeTotal(state, windowStart, windowEnd);
  const runTime = Math.max(0, plannedTime - downtime);
  const available = runTime / plannedTime;
  const performance = runTime > 0 ? produced / (idealRate * runTime) : 0;
  const good = Math.max(0, produced) - rejected;
  const quality = produced > 0 ? good / produced : 0;
  const violations = [];
  if (rejectedRaw > produced) violations.push('rejects-exceed-production');
  return {
    available,
    performance,
    quality,
    oee: available * performance * quality,
    plannedTime,
    runTime,
    downtime,
    produced,
    rejected,
    violations,
    pending: pendingHolds(state),
  };
}
