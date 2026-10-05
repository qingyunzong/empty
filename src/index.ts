export { digestBytes, type Digest } from './digest.js';
export { BackupStore } from './store.js';
export type { Entry, CreateEntry, WriteEntry, DeleteEntry, MoveEntry } from './entry.js';
export { ExternalModificationError, IntegrityError, type StateMismatch } from './errors.js';
export { UndoManager, type BatchResult, type VerifiedPath } from './undo-manager.js';
