/**
 * Base class for every error raised by the event synthesizer so callers can
 * catch component failures with a single `instanceof` check.
 */
export class EventSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An envelope failed structural validation (bad id, non-string predecessor, ...). */
export class InvalidEventError extends EventSynthesisError {}

/**
 * The same event id was ingested twice with content that is not structurally
 * equal (different predecessor set or different payload). The second copy is
 * rejected and the synthesizer keeps the first one.
 */
export class ConflictingEventError extends EventSynthesisError {
  constructor(readonly eventId: string) {
    super(
      `event '${eventId}' was already ingested with a different predecessor set or payload`,
    );
  }
}

/** `confirm()` or `release()` was called while no event was held. */
export class NoHeldEventError extends EventSynthesisError {}

/**
 * A confirmation marker could not be read from the caller-provided store.
 * The synthesizer stops itself; delivering more events without this
 * information could violate the at-most-once redelivery guarantee.
 */
export class ConfirmationReadError extends EventSynthesisError {
  constructor(
    readonly eventId: string,
    override readonly cause: unknown,
  ) {
    super(`could not read the confirmation marker for event '${eventId}'`);
  }
}

/**
 * Writing a confirmation marker failed, so it is unknown whether the write
 * reached durable storage. The event stays held; the next `take()` reads the
 * marker back before deciding what to deliver.
 */
export class WriteOutcomeUnknownError extends EventSynthesisError {
  constructor(
    readonly eventId: string,
    override readonly cause: unknown,
  ) {
    super(
      `writing the confirmation marker for event '${eventId}' failed; the outcome is unknown`,
    );
  }
}

/**
 * The synthesizer was stopped after a confirmation marker could not be read.
 * All ingestion and delivery operations keep throwing until a new instance
 * recovers state from the store.
 */
export class SynthesizerStoppedError extends EventSynthesisError {
  constructor(
    message: string,
    readonly reason: unknown,
  ) {
    super(message);
  }
}
