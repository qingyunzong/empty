export interface Clock {
  now(): number;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return value;
}

export class ManualClock implements Clock {
  #now: number;

  constructor(start = 0) {
    this.#now = finite(start, 'start');
  }

  now(): number {
    return this.#now;
  }

  set(value: number): number {
    this.#now = finite(value, 'value');
    return this.#now;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError('ms must be a finite non-negative number');
    }
    this.#now += ms;
    return this.#now;
  }

  adjust(ms: number): number {
    this.#now += finite(ms, 'ms');
    return this.#now;
  }
}

export interface SyncResult {
  referenceNow: number;
  rawNow: number;
  desiredCorrectionMs: number;
  appliedCorrectionMs: number;
  correctedNow: number;
  driftMs: number;
  withinBound: boolean;
}

export class DriftBoundedClock implements Clock {
  readonly raw: Clock;
  readonly maxDriftMs: number;
  #physicalSkewMs: number;
  #correctionMs = 0;
  #lastSync: SyncResult | null = null;

  constructor(raw: Clock, maxDriftMs: number, physicalSkewMs = 0) {
    if (!Number.isFinite(maxDriftMs) || maxDriftMs < 0) {
      throw new RangeError('maxDriftMs must be a finite non-negative number');
    }
    this.raw = raw;
    this.maxDriftMs = maxDriftMs;
    this.#physicalSkewMs = finite(physicalSkewMs, 'physicalSkewMs');
  }

  get physicalSkewMs(): number {
    return this.#physicalSkewMs;
  }

  setPhysicalSkew(ms: number): void {
    this.#physicalSkewMs = finite(ms, 'physicalSkewMs');
  }

  get correctionMs(): number {
    return this.#correctionMs;
  }

  get lastSync(): SyncResult | null {
    return this.#lastSync;
  }

  rawNow(): number {
    return this.raw.now() + this.#physicalSkewMs;
  }

  now(): number {
    return this.rawNow() + this.#correctionMs;
  }

  synchronize(referenceNow: number): SyncResult {
    const reference = finite(referenceNow, 'referenceNow');
    const rawNow = this.rawNow();
    const desiredCorrectionMs = reference - rawNow;
    const appliedCorrectionMs = Math.max(
      -this.maxDriftMs,
      Math.min(this.maxDriftMs, desiredCorrectionMs),
    );
    this.#correctionMs = appliedCorrectionMs;
    const correctedNow = rawNow + appliedCorrectionMs;
    const driftMs = correctedNow - reference;
    const result: SyncResult = {
      referenceNow: reference,
      rawNow,
      desiredCorrectionMs,
      appliedCorrectionMs,
      correctedNow,
      driftMs,
      withinBound: Math.abs(driftMs) <= this.maxDriftMs,
    };
    this.#lastSync = result;
    return result;
  }

  driftFrom(referenceNow: number): number {
    return this.now() - finite(referenceNow, 'referenceNow');
  }
}
