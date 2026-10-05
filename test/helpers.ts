import { EventLog } from '../src/events.js';
import { PermissionLedger } from '../src/permissions.js';
import { PublishedStore } from '../src/publish.js';
import { TransferEngine } from '../src/engine.js';

export interface Rig {
  log: EventLog;
  ledger: PermissionLedger;
  store: PublishedStore;
  engine: TransferEngine;
}

export function setup(): Rig {
  const log = new EventLog();
  const ledger = new PermissionLedger(log);
  const store = new PublishedStore();
  const engine = new TransferEngine(log, ledger, store);
  return { log, ledger, store, engine };
}
