/**
 * A single observed event for an entity. The event becomes visible to point
 * queries whose timestamp is greater than or equal to `eventTime`.
 */
export interface FeatureEvent {
  entityId: string;
  eventTime: number;
  value: number;
}

/**
 * A reducible fold over the non-empty, visible event window.
 *
 * Synchronous and asynchronous aggregators are both supported; an async
 * aggregator is useful to inject an await barrier so interleaving tests can
 * run deterministically.
 */
export type Aggregator = (values: readonly number[]) => number | Promise<number>;

/** Sentinel meaning "no explicit default configured"; empty windows yield MISSING. */
export const NO_DEFAULT: unique symbol = Symbol("feature.no-default");

/**
 * An immutable, versioned feature definition.
 *
 * `defaultValue` presence is tracked explicitly with the NO_DEFAULT sentinel
 * rather than `undefined`, so that a configured default is never confused with
 * "no default configured".
 */
export interface FeatureDefinition {
  featureId: string;
  versionId: string;
  /** Start of the feature's valid time interval (inclusive); earlier queries resolve to `missing`. */
  validFrom: number;
  /** End of the feature's valid time interval (inclusive); later queries resolve to `missing`. */
  validTo: number;
  /** Window length applied at every query timestamp (events within [t-window+1, t]). */
  window: number;
  aggregate: Aggregator;
  defaultValue: number | typeof NO_DEFAULT;
}

export type FeatureStatus = "present" | "missing" | "default";

/**
 * Three-valued point query result.
 *
 * - present: derived from observed events.
 * - default: the event window was empty but the version defines an explicit
 *   default; `value` is that configured default.
 * - missing: the event window was empty and no default is configured.
 *
 * `missing` and `default` are therefore structurally distinct, never collapsed
 * into a shared null/undefined representation.
 */
export type FeatureResult =
  | {
      featureId: string;
      versionId: string;
      entityId: string;
      timestamp: number;
      status: "present" | "default";
      value: number;
    }
  | {
      featureId: string;
      versionId: string;
      entityId: string;
      timestamp: number;
      status: "missing";
    };

export interface PointQuery {
  entityId: string;
  timestamp: number;
}
