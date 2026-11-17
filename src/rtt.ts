import type { RecoveryConfig, RttSnapshot } from './types.ts';

export const DEFAULT_INITIAL_RTT = 333;
export const DEFAULT_GRANULARITY = 1;
export const DEFAULT_MAX_ACK_DELAY = 25;
export const DEFAULT_TIME_THRESHOLD = 9 / 8;

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

/**
 * RFC 9002 RTT estimator.  The first sample initializes min_rtt with the
 * unadjusted latest_rtt and uses that sample directly for smoothed_rtt and
 * rttvar.  ACK delay is only removed for Application Data after handshake
 * confirmation and is always capped at max_ack_delay.
 */
export class RttEstimator {
  readonly #maxAckDelay: number;
  readonly #granularity: number;
  readonly #timeThreshold: number;

  #latestRtt: number | null = null;
  #minRtt: number | null = null;
  #smoothedRtt: number;
  #rttvar: number;
  #hasSample = false;

  constructor(config: Pick<RecoveryConfig, 'initialRtt' | 'granularity' | 'maxAckDelay' | 'timeThreshold'> = {}) {
    const initialRtt = config.initialRtt ?? DEFAULT_INITIAL_RTT;
    this.#granularity = config.granularity ?? DEFAULT_GRANULARITY;
    this.#maxAckDelay = config.maxAckDelay ?? DEFAULT_MAX_ACK_DELAY;
    this.#timeThreshold = config.timeThreshold ?? DEFAULT_TIME_THRESHOLD;

    assertNonNegativeFinite(initialRtt, 'initialRtt');
    assertNonNegativeFinite(this.#granularity, 'granularity');
    assertNonNegativeFinite(this.#maxAckDelay, 'maxAckDelay');
    assertNonNegativeFinite(this.#timeThreshold, 'timeThreshold');
    if (this.#granularity === 0) {
      throw new RangeError('granularity must be greater than zero');
    }

    this.#smoothedRtt = initialRtt;
    this.#rttvar = initialRtt / 2;
  }

  get latestRtt(): number | null {
    return this.#latestRtt;
  }

  get minRtt(): number | null {
    return this.#minRtt;
  }

  get smoothedRtt(): number {
    return this.#smoothedRtt;
  }

  get rttvar(): number {
    return this.#rttvar;
  }

  get hasSample(): boolean {
    return this.#hasSample;
  }

  /**
   * @param latestRtt Unadjusted RTT sample.
   * @param ackDelay Peer-reported ACK delay.
   * @param applyAckDelay True only for Application Data after handshake
   *   confirmation.
   */
  update(latestRtt: number, ackDelay: number, applyAckDelay: boolean): void {
    assertNonNegativeFinite(latestRtt, 'latestRtt');
    assertNonNegativeFinite(ackDelay, 'ackDelay');

    this.#latestRtt = latestRtt;

    if (!this.#hasSample) {
      this.#minRtt = latestRtt;
      this.#smoothedRtt = latestRtt;
      this.#rttvar = latestRtt / 2;
      this.#hasSample = true;
      return;
    }

    this.#minRtt = Math.min(this.#minRtt as number, latestRtt);

    let adjustedRtt = latestRtt;
    if (applyAckDelay) {
      const cappedDelay = Math.min(ackDelay, this.#maxAckDelay);
      if (latestRtt >= (this.#minRtt as number) + cappedDelay) {
        adjustedRtt = latestRtt - cappedDelay;
      }
    }

    this.#rttvar =
      0.75 * this.#rttvar + 0.25 * Math.abs(this.#smoothedRtt - adjustedRtt);
    this.#smoothedRtt = 0.875 * this.#smoothedRtt + 0.125 * adjustedRtt;
  }

  /** Base PTO period without exponential backoff or max_ack_delay. */
  get ptoBase(): number {
    return (
      this.#smoothedRtt + Math.max(4 * this.#rttvar, this.#granularity)
    );
  }

  /** RFC 9002 time-threshold delay: max(9/8 * max(srtt, latest), granularity). */
  get lossDelay(): number {
    const referenceRtt = Math.max(
      this.#smoothedRtt,
      this.#latestRtt ?? this.#smoothedRtt,
    );
    return Math.max(
      this.#timeThreshold * referenceRtt,
      this.#granularity,
    );
  }

  snapshot(): RttSnapshot {
    return {
      latestRtt: this.#latestRtt,
      minRtt: this.#minRtt,
      smoothedRtt: this.#smoothedRtt,
      rttvar: this.#rttvar,
      hasSample: this.#hasSample,
    };
  }
}

