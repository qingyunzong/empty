import { canonical, sha256hex } from './util.js';

export function makeProof({ accountsDoc, ticksDoc, calls, rolledBack }) {
  const inputHash = sha256hex(canonical({ accounts: accountsDoc, ticks: ticksDoc }));
  const seed = parseInt(inputHash.slice(0, 13), 16); // deterministic, < 2^52
  const scheduleHash = sha256hex(canonical({ calls, rolledBack }));
  return { seed, scheduleHash, inputHash };
}
