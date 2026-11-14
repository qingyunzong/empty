import type { AcknowledgeResult, WatermarkMode } from "./types.ts";

export interface WatermarkOptions {
  initial?: number;
  mode?: WatermarkMode;
}

export interface ObserveResult {
  accepted: boolean;
  reason?: "below-watermark" | "already-observed" | "invalid";
}

/**
 * Tracks application event versions and the committed downstream watermark.
 *
 * Observing an event never advances the watermark. Only `acknowledge` does.
 * In `contiguous` mode a gap blocks further progress; the first acknowledged
 * run anchors an arbitrarily-numbered stream (so a stream starting at version
 * 42 does not require 41 phantom events).
 */
export class WatermarkTracker {
  static create(
    options: WatermarkOptions | number = {},
  ): WatermarkTracker {
    return new WatermarkTracker(options);
  }

  readonly initial: number;
  readonly mode: WatermarkMode;

  #watermark: number;
  #pending = new Set<number>();
  #acknowledged = new Set<number>();
  #hasAdvanced = false;

  constructor(options: WatermarkOptions | number = {}) {
    const config =
      typeof options === "number" ? { initial: options } : options;
    this.initial = normalizeVersion(config.initial ?? 0, "initial watermark");
    this.mode = config.mode ?? "contiguous";
    this.#watermark = this.initial;
  }

  get watermark(): number {
    return this.#watermark;
  }

  get pendingVersions(): number[] {
    return [...this.#pending].sort((a, b) => a - b);
  }

  get value(): number {
    return this.#watermark;
  }

  get acknowledgedButBlockedVersions(): number[] {
    return [...this.#acknowledged].sort((a, b) => a - b);
  }

  observe(version: number): ObserveResult {
    if (!isValidVersion(version)) {
      return { accepted: false, reason: "invalid" };
    }
    if (version <= this.#watermark) {
      return { accepted: false, reason: "below-watermark" };
    }
    if (this.#pending.has(version) || this.#acknowledged.has(version)) {
      return { accepted: false, reason: "already-observed" };
    }
    this.#pending.add(version);
    return { accepted: true };
  }

  hasObserved(version: number): boolean {
    return this.#pending.has(version) || this.#acknowledged.has(version);
  }

  observeVersion(version: number): ObserveResult {
    return this.observe(version);
  }

  acknowledge(version: number): AcknowledgeResult {
    if (!isValidVersion(version)) {
      return {
        status: "unknown-version",
        version,
        previousWatermark: this.#watermark,
        watermark: this.#watermark,
        advanced: false,
      };
    }

    const previousWatermark = this.#watermark;
    if (version <= this.#watermark) {
      return {
        status: "already-acknowledged",
        version,
        previousWatermark,
        watermark: this.#watermark,
        advanced: false,
      };
    }

    if (!this.#pending.has(version) && !this.#acknowledged.has(version)) {
      return {
        status: "unknown-version",
        version,
        previousWatermark,
        watermark: this.#watermark,
        advanced: false,
      };
    }

    this.#pending.delete(version);
    this.#acknowledged.add(version);
    this.#advance(version);

    const advanced = this.#watermark > previousWatermark;
    return {
      status: advanced ? "advanced" : "acknowledged",
      version,
      previousWatermark,
      watermark: this.#watermark,
      advanced,
    };
  }

  ack(version: number): AcknowledgeResult {
    return this.acknowledge(version);
  }

  advance(version: number): AcknowledgeResult {
    return this.acknowledge(version);
  }

  isAcknowledged(version: number): boolean {
    return version <= this.#watermark;
  }

  reset(initial = this.initial): void {
    this.#watermark = normalizeVersion(initial, "initial watermark");
    this.#pending.clear();
    this.#acknowledged.clear();
    this.#hasAdvanced = false;
  }

  #advance(acknowledgedVersion: number): void {
    if (this.mode === "max") {
      if (acknowledgedVersion > this.#watermark) {
        this.#watermark = acknowledgedVersion;
      }
      this.#acknowledged.clear();
      return;
    }

    // Anchor the first contiguous run. This makes the tracker usable with
    // streams whose first version is not exactly initial + 1.
    if (!this.#hasAdvanced) {
      const highestAcknowledged = Math.max(
        acknowledgedVersion,
        ...this.#acknowledged,
      );
      const blockingPending = [...this.#pending].some(
        (pending) => pending < highestAcknowledged,
      );
      if (!blockingPending) {
        this.#watermark = highestAcknowledged;
        for (const value of this.#acknowledged) {
          if (value <= this.#watermark) {
            this.#acknowledged.delete(value);
          }
        }
        this.#hasAdvanced = this.#watermark > this.initial;
      }
    }

    while (this.#acknowledged.has(this.#watermark + 1)) {
      this.#watermark += 1;
      this.#acknowledged.delete(this.#watermark);
      this.#hasAdvanced = true;
    }
  }
}

export function isValidVersion(version: unknown): version is number {
  return (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 0
  );
}

export function normalizeVersion(version: unknown, label = "version"): number {
  if (isValidVersion(version)) {
    return version;
  }
  if (
    typeof version === "string" &&
    version.trim() !== "" &&
    Number.isSafeInteger(Number(version)) &&
    Number(version) >= 0
  ) {
    return Number(version);
  }
  throw new RangeError(`${label} must be a non-negative safe integer`);
}
