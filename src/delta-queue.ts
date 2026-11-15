import { DeltaQueueError } from './errors.js';
import { InMemoryStateStore } from './memory-store.js';
import {
  cloneRecord,
  cloneSnapshot,
  type DeltaQueueSnapshot,
  isRequestComplete,
  latestGeneration,
  requestKey,
  sameGeneration,
} from './snapshot.js';
import type {
  AckReceipt,
  DeltaQueueOptions,
  GenerationKind,
  GenerationRecord,
  GenerationToken,
  PackageDelivery,
  PackageHandleResult,
  PackagePersistCommand,
  RequestOpenParams,
  RequestRecord,
  StateStore,
  SubscriberRecord,
} from './types.js';

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeltaQueueError(
      'INVALID_ARGUMENT',
      `${field} must be a non-empty string`,
      { field },
    );
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DeltaQueueError(
      'INVALID_ARGUMENT',
      `${field} must be a non-negative integer`,
      { field, value },
    );
  }
}

function requireGenerationToken(token: GenerationToken): void {
  requireNonEmpty(token.subscriberId, 'generation.subscriberId');
  if (token.kind !== 'bootstrap' && token.kind !== 'delta') {
    throw new DeltaQueueError(
      'INVALID_ARGUMENT',
      'generation.kind must be "bootstrap" or "delta"',
      { kind: token.kind },
    );
  }
  requirePositiveInteger(token.sequence, 'generation.sequence');
}

/**
 * Pure state machine for ODP-style delta queue confirmation.
 *
 * Invariants enforced:
 * - requests and packages are fenced by an explicit generation token;
 * - bootstrap and delta generations never overlap and cannot interleave;
 * - packages may arrive duplicated and out of order, and are landed once;
 * - a request is only confirmable once every expected package is persisted;
 * - cancel and ack are terminal; late packages never revive a terminal request.
 */
export class DeltaQueue {
  private readonly store: StateStore;
  private readonly clock: () => number;
  private snapshot: DeltaQueueSnapshot;
  private lock: Promise<unknown> = Promise.resolve();

  protected constructor(snapshot: DeltaQueueSnapshot, options: DeltaQueueOptions) {
    this.snapshot = snapshot;
    this.store = options.store ?? new InMemoryStateStore();
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Loads prior durable state, or starts from an empty snapshot. */
  static async create(options: DeltaQueueOptions = {}): Promise<DeltaQueue> {
    const store = options.store ?? new InMemoryStateStore();
    const loaded = await store.load();
    if (loaded.version !== 1) {
      throw new DeltaQueueError(
        'INVALID_ARGUMENT',
        `unsupported snapshot version: ${String(loaded.version)}`,
      );
    }
    return new DeltaQueue(cloneSnapshot(loaded), { ...options, store });
  }

  /** Serializes mutating operations; readers stay lock-free. */
  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lock.then(operation, operation);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async commit(): Promise<void> {
    await this.store.save(cloneSnapshot(this.snapshot));
  }

  private findSubscriber(subscriberId: string): SubscriberRecord | undefined {
    return this.snapshot.subscribers[subscriberId];
  }

  private getRequestRecord(
    subscriberId: string,
    requestId: string,
  ): RequestRecord | undefined {
    return this.snapshot.requests[requestKey(subscriberId, requestId)];
  }

  private requireRequest(
    subscriberId: string,
    requestId: string,
  ): RequestRecord {
    const request = this.getRequestRecord(subscriberId, requestId);
    if (request === undefined) {
      throw new DeltaQueueError(
        'REQUEST_NOT_FOUND',
        `request ${requestId} of subscriber ${subscriberId} does not exist`,
        { subscriberId, requestId },
      );
    }
    return request;
  }

  private requireCurrentGeneration(
    subscriberId: string,
  ): GenerationRecord {
    const subscriber = this.findSubscriber(subscriberId);
    const generation = subscriber === undefined
      ? null
      : latestGeneration(subscriber);
    if (subscriber === undefined || generation === null) {
      throw new DeltaQueueError(
        'GENERATION_NOT_FOUND',
        `subscriber ${subscriberId} has no open generation`,
        { subscriberId },
      );
    }
    return generation;
  }

  /**
   * Opens a new generation. The first generation of a subscriber must be the
   * bootstrap (full load); every later generation is a delta. Deltas may only
   * begin once the previous generation has been sealed, so generations can
   * never overlap or interleave.
   */
  beginGeneration(
    subscriberId: string,
    kind: GenerationKind,
  ): Promise<GenerationRecord> {
    return this.withLock(async () => {
      requireNonEmpty(subscriberId, 'subscriberId');
      const now = this.clock();
      const existing = this.findSubscriber(subscriberId);
      const previous = existing === undefined
        ? null
        : latestGeneration(existing);

      let sequence: number;
      if (previous === null) {
        if (kind !== 'bootstrap') {
          throw new DeltaQueueError(
            'GENERATION_CONFLICT',
            `subscriber ${subscriberId} must start with a bootstrap generation`,
            { subscriberId, requestedKind: kind },
          );
        }
        sequence = 0;
      } else {
        if (!previous.sealed) {
          throw new DeltaQueueError(
            'GENERATION_CONFLICT',
            `generation ${String(previous.sequence)} is still open`,
            { subscriberId, openSequence: previous.sequence },
          );
        }
        if (kind !== 'delta') {
          throw new DeltaQueueError(
            'GENERATION_CONFLICT',
            `subscriber ${subscriberId} already bootstrapped; later generations must be deltas`,
            { subscriberId, requestedKind: kind },
          );
        }
        sequence = previous.sequence + 1;
      }

      const record: GenerationRecord = {
        subscriberId,
        kind,
        sequence,
        sealed: false,
        openedAt: now,
      };
      if (existing === undefined) {
        this.snapshot.subscribers[subscriberId] = {
          subscriberId,
          currentGeneration: {
            subscriberId,
            kind,
            sequence,
          },
          generations: [record],
        };
      } else {
        const generations = [...existing.generations, record];
        this.snapshot.subscribers[subscriberId] = {
          ...existing,
          currentGeneration: { subscriberId, kind, sequence },
          generations,
        };
      }
      await this.commit();
      return cloneRecord(record);
    });
  }

  /**
   * Seals the current generation so no new request can be opened in it.
   * In-flight requests can still receive packages and be acknowledged.
   */
  sealGeneration(subscriberId: string): Promise<GenerationRecord> {
    return this.withLock(async () => {
      requireNonEmpty(subscriberId, 'subscriberId');
      const current = this.requireCurrentGeneration(subscriberId);
      if (current.sealed) {
        return cloneRecord(current);
      }
      const subscriber = this.findSubscriber(subscriberId)!;
      const sealed: GenerationRecord = {
        ...current,
        sealed: true,
        sealedAt: this.clock(),
      };
      const generations = subscriber.generations.map((generation) =>
        generation.sequence === current.sequence ? sealed : generation
      );
      this.snapshot.subscribers[subscriberId] = {
        ...subscriber,
        generations,
      };
      await this.commit();
      return cloneRecord(sealed);
    });
  }

  /** Registers a request bound to its subscriber and generation. */
  openRequest(params: RequestOpenParams): Promise<RequestRecord> {
    return this.withLock(async () => {
      requireNonEmpty(params.subscriberId, 'subscriberId');
      requireNonEmpty(params.requestId, 'requestId');
      requireGenerationToken(params.generation);
      const hasIds = params.expectedPackageIds !== undefined;
      const hasCount = params.expectedPackageCount !== undefined;
      if (hasIds === hasCount) {
        throw new DeltaQueueError(
          'INVALID_ARGUMENT',
          'exactly one of expectedPackageIds or expectedPackageCount is required',
        );
      }

      const current = this.requireCurrentGeneration(params.subscriberId);
      if (!sameGeneration(current, params.generation)) {
        throw new DeltaQueueError(
          'GENERATION_MISMATCH',
          'request generation does not match the current generation',
          {
            subscriberId: params.subscriberId,
            current,
            supplied: params.generation,
          },
        );
      }
      if (current.sealed) {
        throw new DeltaQueueError(
          'GENERATION_SEALED',
          `generation ${String(current.sequence)} is sealed; cannot open requests`,
          { subscriberId: params.subscriberId, sequence: current.sequence },
        );
      }

      let expectedIds: string[] | null = null;
      let expectedCount: number;
      if (hasIds) {
        const ids = [...params.expectedPackageIds!];
        if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
          throw new DeltaQueueError(
            'INVALID_ARGUMENT',
            'expectedPackageIds must contain non-empty strings',
          );
        }
        if (new Set(ids).size !== ids.length) {
          throw new DeltaQueueError(
            'INVALID_ARGUMENT',
            'expectedPackageIds must not contain duplicates',
          );
        }
        expectedIds = ids;
        expectedCount = ids.length;
      } else {
        requirePositiveInteger(
          params.expectedPackageCount!,
          'expectedPackageCount',
        );
        expectedCount = params.expectedPackageCount!;
      }

      const key = requestKey(params.subscriberId, params.requestId);
      const existing = this.snapshot.requests[key];
      if (existing !== undefined) {
        if (sameGeneration(existing.generation, params.generation)) {
          return cloneRecord(existing);
        }
        throw new DeltaQueueError(
          'REQUEST_ALREADY_EXISTS',
          `request ${params.requestId} already exists in another generation`,
          {
            subscriberId: params.subscriberId,
            requestId: params.requestId,
            existingGeneration: existing.generation,
            suppliedGeneration: params.generation,
          },
        );
      }

      const record: RequestRecord = {
        subscriberId: params.subscriberId,
        requestId: params.requestId,
        generation: { ...params.generation },
        state: expectedCount === 0 ? 'persisted' : 'open',
        expectedPackageIds: expectedIds,
        expectedPackageCount: expectedCount,
        receivedPackageIds: [],
        checksumById: {},
        openedAt: this.clock(),
        ...(expectedCount === 0 ? { persistedAt: this.clock() } : {}),
        ...(params.context === undefined ? {} : {
          context: structuredClone(params.context),
        }),
      };
      this.snapshot.requests[key] = record;
      await this.commit();
      return cloneRecord(record);
    });
  }

  /**
   * Handles one pulled package. Packages are idempotent: a repeated delivery
   * is reported as a duplicate without hitting the sink again, and arrival
   * order does not matter. Packages belonging to canceled or already
   * acknowledged requests are ignored as late arrivals.
   */
  async handlePackage(
    delivery: PackageDelivery,
    sink: (command: PackagePersistCommand) => Promise<void>,
  ): Promise<PackageHandleResult> {
    requireNonEmpty(delivery.subscriberId, 'subscriberId');
    requireNonEmpty(delivery.requestId, 'requestId');
    requireNonEmpty(delivery.packageId, 'packageId');
    requireGenerationToken(delivery.generation);

    return this.withLock(async () => {
      const request = this.requireRequest(
        delivery.subscriberId,
        delivery.requestId,
      );
      if (!sameGeneration(request.generation, delivery.generation)) {
        throw new DeltaQueueError(
          'GENERATION_MISMATCH',
          'package generation does not match its request generation',
          {
            subscriberId: delivery.subscriberId,
            requestId: delivery.requestId,
            requestGeneration: request.generation,
            suppliedGeneration: delivery.generation,
          },
        );
      }

      if (request.state === 'canceled') {
        return {
          status: 'ignored',
          reason: 'request-canceled',
          packageId: delivery.packageId,
          request: cloneRecord(request),
        };
      }
      if (request.state === 'acked') {
        return {
          status: 'ignored',
          reason: 'request-acked',
          packageId: delivery.packageId,
          request: cloneRecord(request),
        };
      }

      if (request.receivedPackageIds.includes(delivery.packageId)) {
        const knownChecksum = request.checksumById[delivery.packageId];
        if (
          delivery.checksum !== undefined
          && knownChecksum !== undefined
          && delivery.checksum !== knownChecksum
        ) {
          throw new DeltaQueueError(
            'CHECKSUM_CONFLICT',
            `package ${delivery.packageId} redelivered with a different checksum`,
            {
              subscriberId: delivery.subscriberId,
              requestId: delivery.requestId,
              packageId: delivery.packageId,
              knownChecksum,
              suppliedChecksum: delivery.checksum,
            },
          );
        }
        return {
          status: 'duplicate',
          reason: 'already-persisted',
          packageId: delivery.packageId,
          request: cloneRecord(request),
        };
      }

      if (
        request.expectedPackageIds !== null
        && !request.expectedPackageIds.includes(delivery.packageId)
      ) {
        throw new DeltaQueueError(
          'PACKAGE_UNEXPECTED',
          `package ${delivery.packageId} is not part of request ${delivery.requestId}`,
          {
            subscriberId: delivery.subscriberId,
            requestId: delivery.requestId,
            packageId: delivery.packageId,
          },
        );
      }

      const command: PackagePersistCommand = {
        subscriberId: delivery.subscriberId,
        requestId: delivery.requestId,
        generation: { ...delivery.generation },
        packageId: delivery.packageId,
        payload: delivery.payload,
        ...(delivery.checksum === undefined ? {} : {
          checksum: delivery.checksum,
        }),
      };
      await sink(command);

      const receivedPackageIds = [
        ...request.receivedPackageIds,
        delivery.packageId,
      ];
      if (receivedPackageIds.length > request.expectedPackageCount) {
        throw new DeltaQueueError(
          'PACKAGE_UNEXPECTED',
          `request ${delivery.requestId} received more packages than expected`,
          {
            subscriberId: delivery.subscriberId,
            requestId: delivery.requestId,
            expectedPackageCount: request.expectedPackageCount,
            receivedPackageCount: receivedPackageIds.length,
          },
        );
      }

      const complete = receivedPackageIds.length === request.expectedPackageCount;
      const updated: RequestRecord = {
        ...request,
        receivedPackageIds,
        checksumById: {
          ...request.checksumById,
          [delivery.packageId]: delivery.checksum,
        },
        state: complete ? 'persisted' : 'open',
        ...(complete ? { persistedAt: this.clock() } : {}),
      };
      this.snapshot.requests[requestKey(
        delivery.subscriberId,
        delivery.requestId,
      )] = updated;
      await this.commit();

      return {
        status: 'persisted',
        packageId: delivery.packageId,
        request: cloneRecord(updated),
      };
    });
  }

  /**
   * Emits the final confirmation. Only possible once every expected package
   * has been persisted; retries with the same content are idempotent.
   */
  acknowledge(
    subscriberId: string,
    requestId: string,
  ): Promise<AckReceipt> {
    return this.withLock(async () => {
      requireNonEmpty(subscriberId, 'subscriberId');
      requireNonEmpty(requestId, 'requestId');
      const request = this.requireRequest(subscriberId, requestId);

      if (request.state === 'canceled') {
        throw new DeltaQueueError(
          'REQUEST_TERMINAL',
          `request ${requestId} was canceled and cannot be acknowledged`,
          { subscriberId, requestId },
        );
      }
      if (request.state === 'acked') {
        return this.buildReceipt(request);
      }
      if (request.state !== 'persisted' || !isRequestComplete(request)) {
        throw new DeltaQueueError(
          'REQUEST_NOT_PERSISTED',
          `request ${requestId} is missing persisted packages`,
          {
            subscriberId,
            requestId,
            expectedPackageCount: request.expectedPackageCount,
            receivedPackageCount: request.receivedPackageIds.length,
          },
        );
      }

      const updated: RequestRecord = {
        ...request,
        state: 'acked',
        acknowledgedAt: this.clock(),
      };
      this.snapshot.requests[requestKey(subscriberId, requestId)] = updated;
      await this.commit();
      return this.buildReceipt(updated);
    });
  }

  private buildReceipt(request: RequestRecord): AckReceipt {
    const token: GenerationToken = {
      subscriberId: request.generation.subscriberId,
      kind: request.generation.kind,
      sequence: request.generation.sequence,
    };
    return {
      subscriberId: request.subscriberId,
      requestId: request.requestId,
      generation: token,
      packageIds: [...request.receivedPackageIds],
      packageCount: request.receivedPackageIds.length,
      acknowledgedAt: request.acknowledgedAt ?? this.clock(),
    };
  }

  /**
   * Cancels an open or persisted request. Cancellation is terminal: packages
   * that arrive afterwards are ignored and can never resurrect the request.
   */
  cancelRequest(
    subscriberId: string,
    requestId: string,
  ): Promise<RequestRecord> {
    return this.withLock(async () => {
      requireNonEmpty(subscriberId, 'subscriberId');
      requireNonEmpty(requestId, 'requestId');
      const request = this.requireRequest(subscriberId, requestId);
      if (request.state === 'canceled') {
        return cloneRecord(request);
      }
      if (request.state === 'acked') {
        throw new DeltaQueueError(
          'REQUEST_TERMINAL',
          `request ${requestId} was already acknowledged and cannot be canceled`,
          { subscriberId, requestId },
        );
      }
      const updated: RequestRecord = {
        ...request,
        state: 'canceled',
        canceledAt: this.clock(),
      };
      this.snapshot.requests[requestKey(subscriberId, requestId)] = updated;
      await this.commit();
      return cloneRecord(updated);
    });
  }

  getRequest(subscriberId: string, requestId: string): RequestRecord | null {
    const request = this.getRequestRecord(subscriberId, requestId);
    return request === undefined ? null : cloneRecord(request);
  }

  getCurrentGeneration(subscriberId: string): GenerationRecord | null {
    const subscriber = this.findSubscriber(subscriberId);
    if (subscriber === undefined) {
      return null;
    }
    const generation = latestGeneration(subscriber);
    return generation === null ? null : cloneRecord(generation);
  }

  getSubscriber(subscriberId: string): SubscriberRecord | null {
    const subscriber = this.findSubscriber(subscriberId);
    return subscriber === undefined ? null : cloneRecord(subscriber);
  }

  listRequests(subscriberId: string): RequestRecord[] {
    return Object.values(this.snapshot.requests)
      .filter(
        (request: RequestRecord): boolean =>
          request.subscriberId === subscriberId,
      )
      .map((request: RequestRecord): RequestRecord => cloneRecord(request))
      .sort(
        (left: RequestRecord, right: RequestRecord): number =>
          left.openedAt - right.openedAt,
      );
  }

  /** Exposes a detached deep copy for durability tests or backups. */
  exportSnapshot(): DeltaQueueSnapshot {
    return cloneSnapshot(this.snapshot);
  }
};
