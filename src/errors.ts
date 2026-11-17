export class DeliveryWindowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class BufferFullError extends DeliveryWindowError {
  readonly buffered: number;
  readonly maxBuffered: number;

  constructor(buffered: number, maxBuffered: number) {
    super(`Delivery window buffer is full (${buffered}/${maxBuffered})`);
    this.buffered = buffered;
    this.maxBuffered = maxBuffered;
  }
}

export class SequenceNotDeliveredError extends DeliveryWindowError {
  readonly seq: number;
  readonly highestDelivered: number;

  constructor(seq: number, highestDelivered: number) {
    super(
      `Cannot acknowledge sequence ${seq}: it has not been delivered yet ` +
        `(highest delivered is ${highestDelivered})`,
    );
    this.seq = seq;
    this.highestDelivered = highestDelivered;
  }
}

export class WindowCancelledError extends DeliveryWindowError {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super("Delivery window has been cancelled", { cause: reason });
    this.reason = reason;
  }
}
