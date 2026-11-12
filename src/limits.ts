export interface DecoderLimits {
  /**
   * Maximum bytes in one header line, including the one-byte type prefix and
   * excluding the terminating CRLF.
   */
  maxHeaderBytes: number;
  /** Maximum nesting depth. A top-level value has depth 1. */
  maxDepth: number;
  /** Maximum values in one top-level message, including attributes. */
  maxMessageNodes: number;
  /** Maximum attribute pairs across all attribute blocks in one message. */
  maxAttributePairs: number;
  /** Maximum simple-string, simple-error, and blob payload bytes per message. */
  maxLeafBytes: number;
}

export type DecoderLimitOverrides = Partial<DecoderLimits>;

export const DEFAULT_LIMITS: Readonly<DecoderLimits> = Object.freeze({
  maxHeaderBytes: 65_536,
  maxDepth: 128,
  maxMessageNodes: 1_000_000,
  maxAttributePairs: 10_000,
  maxLeafBytes: 64 * 1024 * 1024,
});

function validateLimit(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `${name} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

export function resolveLimits(
  overrides: DecoderLimitOverrides = {},
): Readonly<DecoderLimits> {
  const limits: DecoderLimits = {
    ...DEFAULT_LIMITS,
    ...overrides,
  };
  validateLimit("maxHeaderBytes", limits.maxHeaderBytes, 1);
  validateLimit("maxDepth", limits.maxDepth, 1);
  validateLimit("maxMessageNodes", limits.maxMessageNodes, 0);
  validateLimit("maxAttributePairs", limits.maxAttributePairs, 0);
  validateLimit("maxLeafBytes", limits.maxLeafBytes, 0);
  return Object.freeze(limits);
}
