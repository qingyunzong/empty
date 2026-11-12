import type { ConfirmationStore } from '../src/store.js';

export class ReadFailure extends Error {
  constructor(eventId: string) {
    super(`simulated read failure for '${eventId}'`);
    this.name = 'ReadFailure';
  }
}

export class WriteFailure extends Error {
  constructor(eventId: string) {
    super(`simulated write failure for '${eventId}'`);
    this.name = 'WriteFailure';
  }
}

/**
 * In-memory {@link ConfirmationStore} whose fault injection switches let the
 * tests reproduce the exact storage outcomes the synthesizer must survive:
 *
 *  - `failReads`   : every `isConfirmed` rejects (simulates a dead store);
 *  - `failWrites`  : every `markConfirmed` rejects and nothing is stored, so
 *                    the write outcome is genuinely unknown;
 *  - `loseNextWrites` : the write actually persists durably but its response
 *                    is lost, i.e. the promise rejects while the marker is in
 *                    fact stored.
 */
export class FaultyConfirmationStore implements ConfirmationStore {
  readonly #markers = new Set<string>();
  readonly readLog: string[] = [];
  readonly writeLog: string[] = [];

  failReads = false;
  failWrites = false;
  loseNextWrites = 0;

  async isConfirmed(eventId: string): Promise<boolean> {
    this.readLog.push(eventId);
    if (this.failReads) {
      throw new ReadFailure(eventId);
    }
    return this.#markers.has(eventId);
  }

  async markConfirmed(eventId: string): Promise<void> {
    this.writeLog.push(eventId);
    if (this.failWrites) {
      throw new WriteFailure(eventId);
    }
    // The marker always lands before the response is "lost", matching real
    // durable storage where the write may complete before the connection dies.
    this.#markers.add(eventId);
    if (this.loseNextWrites > 0) {
      this.loseNextWrites -= 1;
      throw new WriteFailure(eventId);
    }
  }

  /** Test-only inspection of the durable marker state. */
  hasDurableMarker(eventId: string): boolean {
    return this.#markers.has(eventId);
  }

  /** Test-only replacement of the durable marker set, e.g. after a restart. */
  snapshotDurableMarkers(): Set<string> {
    return new Set(this.#markers);
  }
}
