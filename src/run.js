import { MarginEngine } from './engine.js';
import { fullRecompute } from './full.js';
import { makeProof } from './proof.js';

// Core pipeline shared by the CLI and tests: docs in, result object out.
export function runPipeline({ ticksDoc, accountsDoc }) {
  const accounts = Array.isArray(accountsDoc) ? accountsDoc : accountsDoc.accounts;
  const events = Array.isArray(ticksDoc) ? ticksDoc : ticksDoc.events;
  const slots = ticksDoc.slots ?? accountsDoc.slots;
  const slotCapacity = ticksDoc.slotCapacity ?? accountsDoc.slotCapacity ?? 1;
  if (!Array.isArray(accounts) || !Array.isArray(events) || !Number.isInteger(slots)) {
    throw new Error('invalid input: need accounts[], events[] and integer slots');
  }

  const engine = new MarginEngine({ slots, slotCapacity });
  for (const account of accounts) engine.addAccount(account);
  for (const ev of events) {
    if (ev.type === 'undo') engine.undoTick(ev.symbol, ev.version);
    else engine.applyTick(ev);
  }
  const { calls, rolledBack, errors } = engine.finalize();

  // Cross-check the incremental path against an independent full recompute.
  const full = fullRecompute({ accounts, events, slots, slotCapacity });
  const consistent = JSON.stringify(full) === JSON.stringify({ calls, rolledBack, errors });

  const proof = {
    ...makeProof({ accountsDoc, ticksDoc, calls, rolledBack }),
    slots,
    slotCapacity,
    fullRecomputeMatch: consistent,
  };
  return { calls, rolledBack, errors, proof };
}
