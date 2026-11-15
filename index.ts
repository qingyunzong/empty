export * from "./src/types.js";

export {
  DeltaSyncError,
  DeltaFormatError,
  isDeltaSyncError,
} from "./src/errors.js";

export {
  parseDeltaPage,
  defaultGetId,
  defaultGetVersion,
  normalizeServerVersion,
} from "./src/page.js";

export {
  applyDeltaChanges,
  compareServerVersions,
  reconcileChange,
} from "./src/reconcile.js";
export type {
  ApplyDeltaChangesResult,
  ReconcileAction,
  ReconcileOutcome,
  ReconcileReason,
} from "./src/reconcile.js";
export type {
  DeltaSyncErrorCode,
  DeltaSyncErrorOptions,
} from "./src/errors.js";

export {
  MemoryDeltaStore,
  InMemoryDeltaStore,
  createMemoryDeltaStore,
} from "./src/store.js";

export {
  ODataDeltaSync,
  ODataDeltaSync as DeltaSync,
  ODataDeltaSync as DeltaSynchronizer,
  ODataDeltaSync as ODataDeltaClient,
} from "./src/sync.js";

import { ODataDeltaSync } from "./src/sync.js";
import type {
  DeltaCheckpoint,
  DeltaSyncOptions,
  ODataEntity,
  SyncResult,
} from "./src/types.js";

/** Convenience factory matching the class API. */
export function createDeltaSync<T extends ODataEntity = ODataEntity>(
  options: DeltaSyncOptions<T>,
): ODataDeltaSync<T> {
  return new ODataDeltaSync<T>(options);
}

/**
 * One-shot helper. Use the class directly when a failed round must be resumed
 * with the same instance/checkpoint.
 */
export function runDeltaSync<T extends ODataEntity = ODataEntity>(
  options: DeltaSyncOptions<T>,
  initialLink?: string,
): Promise<SyncResult> {
  return new ODataDeltaSync<T>(options).sync(initialLink);
}

/** Restore a serialized checkpoint into a new synchronizer. */
export function resumeDeltaSync<T extends ODataEntity = ODataEntity>(
  options: DeltaSyncOptions<T>,
  checkpoint: DeltaCheckpoint<T>,
): Promise<SyncResult> {
  return ODataDeltaSync.fromCheckpoint(options, checkpoint).sync();
}

export default ODataDeltaSync;
