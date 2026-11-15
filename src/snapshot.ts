import type {
  GenerationRecord,
  GenerationToken,
  RequestRecord,
  SubscriberRecord,
} from './types.js';

export interface DeltaQueueSnapshot {
  readonly version: 1;
  readonly subscribers: Record<string, SubscriberRecord>;
  /** Keyed by `requestKey(subscriberId, requestId)`. */
  readonly requests: Record<string, RequestRecord>;
}

/** ASCII unit separator keeps the composite request key collision-free. */
export function requestKey(subscriberId: string, requestId: string): string {
  return `${subscriberId}\u001f${requestId}`;
}

export function sameGeneration(
  left: GenerationToken,
  right: GenerationToken,
): boolean {
  return (
    left.subscriberId === right.subscriberId
    && left.kind === right.kind
    && left.sequence === right.sequence
  );
}

export function emptySnapshot(): DeltaQueueSnapshot {
  return { version: 1, subscribers: {}, requests: {} };
}

/**
 * Deep clone via structuredClone: snapshots are plain JSON-able data and
 * must never share mutable references with live records.
 */
export function cloneSnapshot(snapshot: DeltaQueueSnapshot): DeltaQueueSnapshot {
  return structuredClone(snapshot);
}

export function cloneRecord<T>(record: T): T {
  return structuredClone(record);
}

export function latestGeneration(
  subscriber: SubscriberRecord,
): GenerationRecord | null {
  const { generations } = subscriber;
  return generations.length === 0
    ? null
    : generations[generations.length - 1]!;
}

export function isRequestComplete(request: RequestRecord): boolean {
  return request.receivedPackageIds.length === request.expectedPackageCount;
}
