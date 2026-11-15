import { DeltaQueue } from './delta-queue.js';
import type {
  AckGateway,
  AckReceipt,
  PackageDelivery,
  PackageHandleResult,
  PackageSink,
} from './types.js';

export interface DeliveryOutcome {
  readonly packageResult: PackageHandleResult;
  /** Present exactly when this delivery completed the whole request. */
  readonly receipt?: AckReceipt;
}

/**
 * Application service wiring the state machine to a persistence sink and an
 * acknowledgment gateway. It keeps the state machine free of I/O concerns:
 * packages are landed through the sink, and the final confirmation is sent
 * only after the request reaches the `persisted` state.
 */
export class DeltaQueueConnector {
  private constructor(
    private readonly queue: DeltaQueue,
    private readonly sink: PackageSink,
    private readonly gateway: AckGateway,
  ) {}

  static create(
    queue: DeltaQueue,
    sink: PackageSink,
    gateway: AckGateway,
  ): DeltaQueueConnector {
    return new DeltaQueueConnector(queue, sink, gateway);
  }

  get stateMachine(): DeltaQueue {
    return this.queue;
  }

  /**
   * Lands one package through the sink. When the package completes the
   * request, the final acknowledgment is sent immediately and its receipt is
   * returned. Duplicate or late packages never trigger another confirmation.
   */
  async deliver(delivery: PackageDelivery): Promise<DeliveryOutcome> {
    const packageResult = await this.queue.handlePackage(
      delivery,
      (command) => this.sink.persistPackage(command),
    );
    if (
      packageResult.status === 'persisted'
      && packageResult.request.state === 'persisted'
    ) {
      const receipt = await this.queue.acknowledge(
        delivery.subscriberId,
        delivery.requestId,
      );
      await this.gateway.confirm(receipt);
      return { packageResult, receipt };
    }
    return { packageResult };
  }

  /**
   * Acknowledges an already-complete request explicitly (e.g. after a
   * gateway retry). Sends the receipt through the gateway every time.
   */
  async confirm(subscriberId: string, requestId: string): Promise<AckReceipt> {
    const receipt = await this.queue.acknowledge(subscriberId, requestId);
    await this.gateway.confirm(receipt);
    return receipt;
  }
}
