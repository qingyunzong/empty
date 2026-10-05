export { PersistentLog, type LogEntry } from "./log.js";
export { ReplicaRegistry, type EpochRecord } from "./registry.js";
export { SnapshotStore, type Snapshot } from "./snapshot.js";
export { compactionHorizon } from "./compactor.js";
export {
  LogCompactionSystem,
  ZeroVectorRegistrationError,
  StaleSnapshotError,
  type Reducer,
  type RecoveredState,
} from "./system.js";
