/**
 * Persistent storage owned by the caller. The synthesizer only ever stores a
 * boolean "this event id is confirmed" marker; how the marker is made durable
 * (files, a transactional key/value service, ...) is the caller's decision.
 *
 * Both methods may reject. A rejected `write` is treated as an unknown
 * outcome, not as a definite failure, and is followed by a `read`.
 */
export interface ConfirmationStore {
  /**
   * Returns `true` when a durable confirmation marker exists for `eventId`.
   * Rejecting this method stops the synthesizer because redelivery would no
   * longer be safe.
   */
  isConfirmed(eventId: string): Promise<boolean>;

  /**
   * Durably records the confirmation marker for `eventId`. A rejection means
   * the outcome is unknown; the caller or the synthesizer must read the
   * marker back before redelivering the event.
   */
  markConfirmed(eventId: string): Promise<void>;
}
