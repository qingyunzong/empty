export {
  EventSynthesizer,
  type EventEnvelope,
  type SynthesisReport,
} from './src/synthesizer.js';
export type { ConfirmationStore } from './src/store.js';
export {
  EventSynthesisError,
  InvalidEventError,
  ConflictingEventError,
  NoHeldEventError,
  ConfirmationReadError,
  WriteOutcomeUnknownError,
  SynthesizerStoppedError,
} from './src/errors.js';
