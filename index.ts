export * from "./src/connection.ts";
export * from "./src/errors.ts";
export * from "./src/types.ts";
export * from "./src/util.ts";
export * from "./src/watermark.ts";

import { SubscriptionConnection } from "./src/connection.ts";
import type { SubscriptionConnectionOptions } from "./src/types.ts";
import { WatermarkTracker } from "./src/watermark.ts";
import type { WatermarkOptions } from "./src/watermark.ts";

/** Common names for the same state machine. */
export {
  SubscriptionConnection as ConnectionState,
  SubscriptionConnection as ConnectionStateMachine,
  SubscriptionConnection as ConnectionManager,
  SubscriptionConnection as ConnectionTracker,
  SubscriptionConnection as GraphQLSubscriptionConnection,
  SubscriptionConnection as GraphQLSubscriptionState,
  SubscriptionConnection as SubscriptionClient,
  SubscriptionConnection as SubscriptionManager,
  SubscriptionConnection as SubscriptionState,
  SubscriptionConnection as SubscriptionStateMachine,
  SubscriptionConnection as SubscriptionConnectionState,
  SubscriptionConnection as SubscriptionTracker,
  WatermarkTracker as Watermark,
  WatermarkTracker as DedupWatermark,
  WatermarkTracker as DedupeWatermark,
  WatermarkTracker as SubscriptionWatermark,
  WatermarkTracker as WatermarkState,
  WatermarkTracker as SubscriptionWatermarkTracker,
};

export function createConnectionState(
  options: SubscriptionConnectionOptions = {},
): SubscriptionConnection {
  return new SubscriptionConnection(options);
}

export const createConnectionStateMachine = createConnectionState;
export const createConnectionTracker = createConnectionState;
export const createConnectionManager = createConnectionState;
export const createGraphQLSubscriptionConnection = createConnectionState;
export const createGraphQLSubscriptionState = createConnectionState;
export const createGraphQLSubscriptionStateMachine = createConnectionState;
export const createSubscriptionClient = createConnectionState;
export const createSubscriptionConnection = createConnectionState;
export const createSubscriptionState = createConnectionState;
export const createSubscriptionStateMachine = createConnectionState;
export const createSubscriptionManager = createConnectionState;
export const createSubscriptionTracker = createConnectionState;
export const createSubscriptionConnectionState = createConnectionState;

export function createWatermarkTracker(
  options: WatermarkOptions | number = {},
): WatermarkTracker {
  return new WatermarkTracker(options);
}

export const createDedupWatermark = createWatermarkTracker;
export const createSubscriptionWatermark = createWatermarkTracker;

export default SubscriptionConnection;
